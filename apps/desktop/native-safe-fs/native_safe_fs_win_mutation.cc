#include "native_safe_fs_win_mutation.h"

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
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
constexpr uint32_t kRegularFileType = 0100000;
constexpr uint32_t kDirectoryType = 0040000;
constexpr NTSTATUS kStatusInvalidDeviceRequest = static_cast<NTSTATUS>(0xC0000010L);
constexpr NTSTATUS kStatusObjectNameInvalid = static_cast<NTSTATUS>(0xC0000033L);
constexpr NTSTATUS kStatusObjectNameNotFound = static_cast<NTSTATUS>(0xC0000034L);
constexpr NTSTATUS kStatusObjectNameCollision = static_cast<NTSTATUS>(0xC0000035L);
constexpr NTSTATUS kStatusObjectPathNotFound = static_cast<NTSTATUS>(0xC000003AL);
constexpr NTSTATUS kStatusSharingViolation = static_cast<NTSTATUS>(0xC0000043L);
constexpr NTSTATUS kStatusFileIsADirectory = static_cast<NTSTATUS>(0xC00000BAL);
constexpr NTSTATUS kStatusNotSupported = static_cast<NTSTATUS>(0xC00000BBL);
constexpr NTSTATUS kStatusNotSameDevice = static_cast<NTSTATUS>(0xC00000D4L);
constexpr NTSTATUS kStatusNotADirectory = static_cast<NTSTATUS>(0xC0000103L);
constexpr NTSTATUS kStatusInvalidParameter = static_cast<NTSTATUS>(0xC000000DL);
constexpr size_t kReservedPrefixLength = 19;
constexpr wchar_t kTemporaryPrefix[] = L".sprint-coder-temp-";
constexpr wchar_t kTombstonePrefix[] = L".sprint-coder-tomb-";
// Windows has no atomic exchange. An update parks the displaced revision under this name between
// its renames, and every observation of the intent resolves a parked revision back to the endpoint
// it logically still occupies (see ObserveIntentView).
constexpr wchar_t kSwapPrefix[] = L".sprint-coder-swap-";
// The durable ownership proof for a created directory, the Windows counterpart of the POSIX
// `user.sprint-coder.mkdir-owner` xattr. It survives removal of the visible marker file.
constexpr wchar_t kOwnershipStream[] = L":sprint-coder.mkdir-owner:$DATA";
// FILE_DISPOSITION_INFO_EX (Windows 10 1709+). POSIX semantics unlink the name when the handle
// closes instead of leaving a delete-pending entry behind another reader's handle.
constexpr int kFileDispositionInfoExClass = 21;
constexpr DWORD kDispositionDelete = 0x1;
constexpr DWORD kDispositionPosixSemantics = 0x2;
constexpr DWORD kDispositionIgnoreReadonly = 0x10;
constexpr ACCESS_MASK kDirectoryReadAccess =
    FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
// FlushFileBuffers on a directory requires FILE_ADD_FILE (FILE_WRITE_DATA for directories).
constexpr ACCESS_MASK kDirectoryFlushAccess = FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY;
// Without FILE_SHARE_DELETE nobody can rename or delete a pinned directory or a held file.
constexpr ULONG kPinShare = FILE_SHARE_READ | FILE_SHARE_WRITE;
constexpr ULONG kObserveShare = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

struct HandleCloser {
  void operator()(void* value) const {
    HANDLE handle = static_cast<HANDLE>(value);
    if (handle != nullptr && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  }
};
using OwnedHandle = std::unique_ptr<void, HandleCloser>;

struct Failure {
  std::string code;
  std::string message;
};

bool Fail(Failure* failure, const char* code, const char* message) {
  if (failure->code.empty()) *failure = {code, message};
  return false;
}

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
  // Windows cannot store a POSIX mode, so an artifact staged with a mode the attributes cannot
  // express (the 0600 of a new file) reports that mode for the rest of the session.
  std::unordered_map<std::string, uint32_t> observed_modes;
};

struct EndpointRevision {
  bool present = false;
  std::string identity_digest;
  std::string content_hash;
  uint64_t size = 0;
  uint32_t mode = kRegularFileType | 0666;
};

struct FileFacts {
  uint64_t dev = 0;
  uint64_t ino = 0;
  uint64_t size = 0;
  uint32_t links = 0;
  DWORD attributes = 0;
  LONGLONG change_time = 0;
  LONGLONG write_time = 0;
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

napi_value MakeUndefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value ThrowFailure(napi_env env, const char* code, const char* message) {
  napi_value error;
  napi_create_error(env, nullptr, MakeString(env, message), &error);
  napi_set_named_property(env, error, "code", MakeString(env, code));
  napi_throw(env, error);
  return nullptr;
}

napi_value ThrowFailure(napi_env env, const Failure& failure) {
  return failure.code.empty()
             ? ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs operation failed")
             : ThrowFailure(env, failure.code.c_str(), failure.message.c_str());
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

bool NamedIsNull(napi_env env, napi_value object, const char* name, bool* output) {
  napi_value value;
  napi_valuetype type = napi_undefined;
  if (!NamedValue(env, object, name, &value) || napi_typeof(env, value, &type) != napi_ok)
    return false;
  *output = type == napi_null;
  return true;
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

std::wstring AsciiToWide(const std::string& input) {
  return std::wstring(input.begin(), input.end());
}

std::wstring Uppercase(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](wchar_t character) { return static_cast<wchar_t>(towupper(character)); });
  return value;
}

bool IsSafeSegment(const std::wstring& segment) {
  if (segment.empty() || segment.size() > 255 || segment == L"." || segment == L".." ||
      segment.back() == L'.' || segment.back() == L' ' ||
      segment.find_first_of(L"\\/:*?\"<>|") != std::wstring::npos ||
      std::any_of(segment.begin(), segment.end(), [](wchar_t character) { return character < 32; }))
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

bool ReadSegments(napi_env env, napi_value object, const char* name, bool allow_empty,
                  std::vector<std::wstring>* output) {
  napi_value value;
  bool array = false;
  uint32_t length = 0;
  if (!NamedValue(env, object, name, &value) || napi_is_array(env, value, &array) != napi_ok ||
      !array || napi_get_array_length(env, value, &length) != napi_ok || length > 128 ||
      (!allow_empty && length == 0))
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

// Reads a segment array that the raw contract allows to be null.
bool ReadNullableSegments(napi_env env, napi_value object, const char* name, bool* is_null,
                          std::vector<std::wstring>* output) {
  if (!NamedIsNull(env, object, name, is_null)) return false;
  if (*is_null) {
    output->clear();
    return true;
  }
  return ReadSegments(env, object, name, false, output);
}

std::vector<std::wstring> ParentOf(const std::vector<std::wstring>& segments) {
  return std::vector<std::wstring>(segments.begin(), segments.end() - 1);
}

bool IsReservedLeaf(const std::wstring& leaf, const wchar_t* prefix) {
  if (leaf.size() != kReservedPrefixLength + 32 ||
      leaf.compare(0, kReservedPrefixLength, prefix) != 0)
    return false;
  return std::all_of(leaf.begin() + kReservedPrefixLength, leaf.end(), [](wchar_t character) {
    return (character >= L'0' && character <= L'9') ||
           (character >= L'a' && character <= L'f');
  });
}

bool IsTemporaryLeaf(const std::wstring& leaf) { return IsReservedLeaf(leaf, kTemporaryPrefix); }

std::wstring SwapLeafFor(const std::wstring& temporary_leaf) {
  return kSwapPrefix + temporary_leaf.substr(kReservedPrefixLength);
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

// Opens `name` relative to `parent` without following a reparse point. An empty name reopens
// `parent` itself with the requested access and sharing. `security` applies only to a creation.
NTSTATUS OpenRelative(HANDLE parent, const std::wstring& name, ACCESS_MASK access, ULONG share,
                      ULONG disposition, ULONG options, ULONG attributes, HANDLE* output,
                      PSECURITY_DESCRIPTOR security = nullptr) {
  NtCreateFileFn create_file = ResolveNtCreateFile();
  if (create_file == nullptr) return static_cast<NTSTATUS>(0xC0000002L);
  UNICODE_STRING unicode{};
  unicode.Buffer = const_cast<PWSTR>(name.data());
  unicode.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  unicode.MaximumLength = unicode.Length;
  OBJECT_ATTRIBUTES object{};
  InitializeObjectAttributes(&object, &unicode, OBJ_CASE_INSENSITIVE, parent, security);
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

bool QueryFacts(HANDLE handle, FileFacts* facts) {
  BY_HANDLE_FILE_INFORMATION info{};
  FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandle(handle, &info) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic)))
    return false;
  facts->dev = info.dwVolumeSerialNumber;
  facts->ino = (static_cast<uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
  facts->size = (static_cast<uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
  facts->links = info.nNumberOfLinks;
  facts->attributes = info.dwFileAttributes;
  facts->change_time = basic.ChangeTime.QuadPart;
  facts->write_time = basic.LastWriteTime.QuadPart;
  return true;
}

bool SameFacts(const FileFacts& left, const FileFacts& right) {
  return left.dev == right.dev && left.ino == right.ino && left.size == right.size &&
         left.links == right.links && left.attributes == right.attributes &&
         left.change_time == right.change_time && left.write_time == right.write_time;
}

bool SameObject(const FileFacts& left, const FileFacts& right) {
  return left.dev == right.dev && left.ino == right.ino;
}

// libuv's st_mode on Windows: read-only attribute gives 0444, anything else 0666.
uint32_t NodeCompatibleMode(DWORD attributes, uint32_t type) {
  return type | ((attributes & FILE_ATTRIBUTE_READONLY) != 0 ? 0444 : 0666);
}

bool FileIdentity(HANDLE handle, uint64_t* dev, uint64_t* ino, uint32_t* links) {
  FileFacts facts;
  if (!QueryFacts(handle, &facts)) return false;
  *dev = facts.dev;
  *ino = facts.ino;
  *links = facts.links;
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

bool FileIdentityDigest(const FileFacts& facts, std::string* output) {
  return WindowsNativeFileIdentityDigest(facts.dev, facts.ino, facts.attributes, facts.links,
                                         output);
}

bool DirectoryIdentityDigest(const FileFacts& facts, std::string* output) {
  return Sha256String("[\"native-directory-identity-v1\",\"" + std::to_string(facts.dev) +
                          "\",\"" + std::to_string(facts.ino) + "\"," +
                          std::to_string(NodeCompatibleMode(facts.attributes, kDirectoryType)) +
                          ",\"directory\"]",
                      output);
}

bool OwnedDirectoryIdentityDigest(const FileFacts& facts, const std::string& token,
                                  std::string* output) {
  std::string directory;
  return DirectoryIdentityDigest(facts, &directory) &&
         Sha256String("[\"native-owned-directory-identity-v1\",\"" + directory + "\",\"" +
                          token + "\"]",
                      output);
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

bool ReadAll(HANDLE handle, uint64_t size, std::vector<uint8_t>* bytes) {
  if (size > kMaxArtifactBytes) return false;
  LARGE_INTEGER start{};
  if (!SetFilePointerEx(handle, start, nullptr, FILE_BEGIN)) return false;
  bytes->assign(static_cast<size_t>(size), 0);
  size_t offset = 0;
  while (offset < bytes->size()) {
    DWORD read = 0;
    DWORD requested = static_cast<DWORD>(std::min<size_t>(bytes->size() - offset, 65536));
    if (!ReadFile(handle, bytes->data() + offset, requested, &read, nullptr) || read == 0)
      return false;
    offset += read;
  }
  return true;
}

// Observes one unique regular file through its handle. The facts are read before and after the
// content so a concurrent write through another handle cannot be reported as one revision.
bool ObserveHandle(HANDLE handle, EndpointRevision* output) {
  FileFacts before;
  if (!QueryFacts(handle, &before) ||
      (before.attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0 ||
      before.links != 1 || GetFileType(handle) != FILE_TYPE_DISK ||
      before.size > kMaxArtifactBytes)
    return false;
  std::vector<uint8_t> bytes;
  std::string content_hash;
  FileFacts after;
  std::string identity;
  if (!ReadAll(handle, before.size, &bytes) ||
      !Sha256Bytes(bytes.data(), bytes.size(), &content_hash) || !QueryFacts(handle, &after) ||
      !SameFacts(before, after) || !FileIdentityDigest(after, &identity))
    return false;
  output->present = true;
  output->identity_digest = std::move(identity);
  output->content_hash = std::move(content_hash);
  output->size = after.size;
  output->mode = NodeCompatibleMode(after.attributes, kRegularFileType);
  return true;
}

void ApplyObservedMode(const MutationSession& session, EndpointRevision* revision) {
  const auto mode = session.observed_modes.find(revision->identity_digest);
  if (mode != session.observed_modes.end()) revision->mode = mode->second;
}

bool OpenDirectoryPath(HANDLE root, const std::vector<std::wstring>& segments,
                       OwnedHandle* output) {
  OwnedHandle current = DuplicateOwnedHandle(root);
  if (!current) return false;
  for (const std::wstring& segment : segments) {
    HANDLE child = INVALID_HANDLE_VALUE;
    const NTSTATUS status =
        OpenRelative(current.get(), segment, kDirectoryReadAccess, kObserveShare, FILE_OPEN,
                     FILE_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &child);
    if (status < 0) return false;
    OwnedHandle next(child);
    if (IsReparsePoint(next.get()) || !IsDirectoryHandle(next.get())) return false;
    current = std::move(next);
  }
  *output = std::move(current);
  return true;
}

// The directory chain a mutation runs through, from the Workspace root to the endpoint's parent.
// Every link is held without FILE_SHARE_DELETE, so no directory on the way can be renamed,
// deleted or replaced while the effect is in flight; handle-relative opens below the last link
// can only reach the objects that were pinned.
struct PinnedDirectory {
  std::vector<OwnedHandle> chain;
  FileFacts facts;
  HANDLE get() const { return chain.back().get(); }
};

bool PinDirectoryPath(HANDLE root, const std::vector<std::wstring>& segments, bool flushable,
                      PinnedDirectory* output) {
  output->chain.clear();
  for (size_t index = 0; index <= segments.size(); ++index) {
    const bool last = index == segments.size();
    const ACCESS_MASK access = kDirectoryReadAccess | (last && flushable ? kDirectoryFlushAccess : 0);
    HANDLE raw = INVALID_HANDLE_VALUE;
    const NTSTATUS status =
        OpenRelative(index == 0 ? root : output->chain.back().get(),
                     index == 0 ? std::wstring() : segments[index - 1], access, kPinShare,
                     FILE_OPEN, FILE_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &raw);
    if (status < 0) return false;
    output->chain.emplace_back(raw);
    if (IsReparsePoint(output->chain.back().get()) ||
        !IsDirectoryHandle(output->chain.back().get()))
      return false;
  }
  return QueryFacts(output->get(), &output->facts);
}

enum class EndpointResult { kAbsent, kPresent, kUnsafe, kFailure };

EndpointResult OpenStatusResult(NTSTATUS status) {
  if (status == kStatusObjectNameNotFound || status == kStatusObjectPathNotFound)
    return EndpointResult::kAbsent;
  if (status == kStatusSharingViolation || status == kStatusFileIsADirectory ||
      status == kStatusNotADirectory)
    return EndpointResult::kUnsafe;
  return EndpointResult::kFailure;
}

EndpointResult ObserveEndpoint(const std::shared_ptr<MutationSession>& session,
                               const std::vector<std::wstring>& segments,
                               EndpointRevision* revision, OwnedHandle* held = nullptr,
                               ACCESS_MASK extra_access = 0, ULONG share = kObserveShare) {
  if (segments.empty()) return EndpointResult::kUnsafe;
  OwnedHandle parent;
  if (!OpenDirectoryPath(session->root.get(), ParentOf(segments), &parent))
    return EndpointResult::kUnsafe;
  HANDLE file = INVALID_HANDLE_VALUE;
  const NTSTATUS status = OpenRelative(
      parent.get(), segments.back(), FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE |
                                         extra_access,
      share, FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &file);
  if (status < 0) {
    const EndpointResult result = OpenStatusResult(status);
    if (result == EndpointResult::kAbsent) revision->present = false;
    return result;
  }
  OwnedHandle owned(file);
  EndpointRevision observed;
  if (!ObserveHandle(owned.get(), &observed)) return EndpointResult::kUnsafe;
  ApplyObservedMode(*session, &observed);
  *revision = std::move(observed);
  if (held != nullptr) *held = std::move(owned);
  return EndpointResult::kPresent;
}

// Opens and observes the endpoint a kernel call is about to move or delete. FILE_SHARE_READ keeps
// every writer, deleter and renamer out until the handle closes; a sharing violation (another
// writer, an antivirus scan) is retried briefly and then refused rather than waited on.
EndpointResult HoldEndpoint(const MutationSession& session, HANDLE parent, const std::wstring& leaf,
                            EndpointRevision* revision, OwnedHandle* held) {
  HANDLE raw = INVALID_HANDLE_VALUE;
  NTSTATUS status = 0;
  for (int attempt = 0;; ++attempt) {
    status = OpenRelative(parent, leaf, FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
                          FILE_SHARE_READ, FILE_OPEN, FILE_NON_DIRECTORY_FILE,
                          FILE_ATTRIBUTE_NORMAL, &raw);
    if (status != kStatusSharingViolation || attempt >= 4) break;
    Sleep(25);
  }
  if (status < 0) return OpenStatusResult(status);
  OwnedHandle owned(raw);
  EndpointRevision observed;
  if (!ObserveHandle(owned.get(), &observed)) return EndpointResult::kUnsafe;
  ApplyObservedMode(session, &observed);
  *revision = std::move(observed);
  *held = std::move(owned);
  return EndpointResult::kPresent;
}

// Whether any entry, of any kind, exists under `leaf`.
EndpointResult ProbeName(HANDLE parent, const std::wstring& leaf) {
  HANDLE raw = INVALID_HANDLE_VALUE;
  const NTSTATUS status = OpenRelative(parent, leaf, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                       kObserveShare, FILE_OPEN, 0, FILE_ATTRIBUTE_NORMAL, &raw);
  if (status >= 0) {
    CloseHandle(raw);
    return EndpointResult::kPresent;
  }
  const EndpointResult result = OpenStatusResult(status);
  return result == EndpointResult::kUnsafe ? EndpointResult::kPresent : result;
}

napi_value AbsentEndpoint(napi_env env) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "state", MakeString(env, "absent"));
  return result;
}

napi_value RevisionValue(napi_env env, const EndpointRevision& revision) {
  if (!revision.present) return AbsentEndpoint(env);
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

napi_value EffectValue(napi_env env, const EndpointRevision& source,
                       const EndpointRevision& destination, const EndpointRevision& auxiliary) {
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "source", RevisionValue(env, source));
  napi_set_named_property(env, result, "destination", RevisionValue(env, destination));
  napi_set_named_property(env, result, "auxiliary", RevisionValue(env, auxiliary));
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

// Rechecked immediately before every kernel call: an invalidation from another thread between the
// entry check and the effect must stop the effect, never race it.
bool SessionCurrent(const std::shared_ptr<MutationSession>& session) {
  std::lock_guard<std::mutex> guard(sessions_mutex);
  const auto found = sessions.find(session->id);
  return found != sessions.end() && found->second == session && !session->stale &&
         session->fence > minimum_fences[session->workspace_key];
}

bool ReadJournalBinding(napi_env env, napi_value input, std::string* id,
                        std::string* intent_digest, std::string* record_digest,
                        uint32_t* revision) {
  if (!NamedString(env, input, "intentId", id) || id->size() > 200 ||
      !NamedString(env, input, "intentDigest", intent_digest) ||
      !IsLowerHex(*intent_digest, 64) ||
      !NamedString(env, input, "recordDigest", record_digest) ||
      !IsLowerHex(*record_digest, 64) || !NamedUint32(env, input, "revision", revision)) {
    ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs journal binding");
    return false;
  }
  return true;
}

// Observation is read-only, so like the POSIX backend it validates the binding's form without
// recording it: a restarted process may observe an intent sealed under another session or nonce.
bool ValidateJournalBinding(napi_env env, napi_value input) {
  std::string id, intent_digest, record_digest;
  uint32_t revision = 0;
  return ReadJournalBinding(env, input, &id, &intent_digest, &record_digest, &revision);
}

// Every path that can write (stage, apply, cleanup) binds the intent to the session and refuses a
// changed digest or an older revision.
bool BindJournal(napi_env env, napi_value input, MutationSession* session) {
  std::string id, intent_digest, record_digest;
  uint32_t revision = 0;
  if (!ReadJournalBinding(env, input, &id, &intent_digest, &record_digest, &revision))
    return false;
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

// Reads an endpoint expectation of the raw effect contract: `absent`, or one unique regular file.
bool ReadExpectation(napi_env env, napi_value object, const char* name, EndpointRevision* output) {
  napi_value value;
  std::string state;
  if (!NamedValue(env, object, name, &value) || !NamedString(env, value, "state", &state))
    return false;
  if (state == "absent") {
    *output = EndpointRevision{};
    return true;
  }
  uint32_t links = 0;
  if (state != "present" ||
      !NamedString(env, value, "identityDigest", &output->identity_digest) ||
      !IsLowerHex(output->identity_digest, 64) ||
      !NamedString(env, value, "contentHash", &output->content_hash) ||
      !IsLowerHex(output->content_hash, 64) || !NamedUint32(env, value, "mode", &output->mode) ||
      (output->mode & 0170000) != kRegularFileType || !NamedUint32(env, value, "nlink", &links) ||
      links != 1)
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

bool SameRevision(const EndpointRevision& left, const EndpointRevision& right) {
  return left.present && right.present && left.identity_digest == right.identity_digest &&
         left.content_hash == right.content_hash && left.size == right.size &&
         left.mode == right.mode;
}

bool Matches(const EndpointRevision& actual, const EndpointRevision& expected) {
  return actual.present == expected.present && (!actual.present || SameRevision(actual, expected));
}

// ReplaceIfExists stays FALSE for every caller: an occupied target is a collision to refuse, never
// a file to overwrite.
NTSTATUS MoveHandleNoReplace(HANDLE file, HANDLE target_parent, const std::wstring& leaf) {
  NtSetInformationFileFn set_information = ResolveNtSetInformationFile();
  if (set_information == nullptr) return static_cast<NTSTATUS>(0xC0000002L);
  const size_t bytes = sizeof(FILE_RENAME_INFO) + leaf.size() * sizeof(wchar_t);
  std::vector<uint8_t> storage(bytes, 0);
  auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
  rename->ReplaceIfExists = FALSE;
  rename->RootDirectory = target_parent;
  rename->FileNameLength = static_cast<DWORD>(leaf.size() * sizeof(wchar_t));
  std::memcpy(rename->FileName, leaf.data(), rename->FileNameLength);
  IO_STATUS_BLOCK status{};
  return set_information(file, &status, rename, static_cast<ULONG>(bytes),
                         static_cast<FILE_INFORMATION_CLASS>(10));
}

bool MoveFailure(NTSTATUS status, Failure* failure) {
  if (status == kStatusObjectNameCollision || status == kStatusObjectNameNotFound ||
      status == kStatusObjectPathNotFound || status == kStatusSharingViolation)
    return Fail(failure, "UNSAFE_PATH", "NativeSafeFs atomic move target changed");
  if (status == kStatusNotSameDevice || status == kStatusNotSupported ||
      status == kStatusInvalidDeviceRequest)
    return Fail(failure, "UNSUPPORTED_PLATFORM", "NativeSafeFs atomic move is unsupported");
  return Fail(failure, "NATIVE_FAILURE", "NativeSafeFs atomic move failed");
}

// Deletes the object behind a handle opened with DELETE access. Directories must be empty; the
// file system checks that when the disposition is set, and a delete-pending directory refuses new
// children, so emptiness cannot change between the check and the removal.
bool DeleteHeld(HANDLE handle, DWORD* error) {
  struct {
    DWORD Flags;
  } extended{kDispositionDelete | kDispositionPosixSemantics | kDispositionIgnoreReadonly};
  if (SetFileInformationByHandle(handle,
                                 static_cast<FILE_INFO_BY_HANDLE_CLASS>(kFileDispositionInfoExClass),
                                 &extended, sizeof(extended)))
    return true;
  *error = GetLastError();
  if (*error != ERROR_INVALID_PARAMETER && *error != ERROR_NOT_SUPPORTED &&
      *error != ERROR_INVALID_FUNCTION)
    return false;
  FILE_DISPOSITION_INFO classic{TRUE};
  if (SetFileInformationByHandle(handle, FileDispositionInfo, &classic, sizeof(classic)))
    return true;
  *error = GetLastError();
  return false;
}

bool ProcessUserSid(std::vector<unsigned char>* storage, PSID* sid) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  OwnedHandle owned(token);
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) return false;
  storage->resize(size);
  if (!GetTokenInformation(token, TokenUser, storage->data(), size, &size)) return false;
  *sid = reinterpret_cast<TOKEN_USER*>(storage->data())->User.Sid;
  return true;
}

// The owner every file this process creates receives by default. An elevated token defaults to
// BUILTIN\Administrators rather than to the user.
bool ProcessDefaultOwnerSid(std::vector<unsigned char>* storage, PSID* sid) {
#if defined(SPRINT_CODER_NATIVE_SAFE_FS_TESTING)
  // Test builds only: stands in for a token whose default owner is another SID (an elevated one).
  wchar_t text[256]{};
  const DWORD length =
      GetEnvironmentVariableW(L"SPRINT_CODER_NATIVE_SAFE_FS_TOKEN_OWNER_SID", text, 256);
  if (length > 0 && length < 256) {
    PSID converted = nullptr;
    if (!ConvertStringSidToSidW(text, &converted)) return false;
    storage->resize(GetLengthSid(converted));
    const bool copied =
        CopySid(static_cast<DWORD>(storage->size()), storage->data(), converted) != FALSE;
    LocalFree(converted);
    *sid = storage->data();
    return copied;
  }
#endif
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  OwnedHandle owned(token);
  DWORD size = 0;
  GetTokenInformation(token, TokenOwner, nullptr, 0, &size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) return false;
  storage->resize(size);
  if (!GetTokenInformation(token, TokenOwner, storage->data(), size, &size)) return false;
  *sid = reinterpret_cast<TOKEN_OWNER*>(storage->data())->Owner;
  return true;
}

// What the volume under a handle supports. Test builds can clear flags to stand in for a volume
// without named streams, extended attributes or persistent ACLs (FAT, exFAT, a Dev Drive).
bool VolumeFlags(HANDLE handle, DWORD* flags) {
  if (!GetVolumeInformationByHandleW(handle, nullptr, 0, nullptr, nullptr, flags, nullptr, 0))
    return false;
#if defined(SPRINT_CODER_NATIVE_SAFE_FS_TESTING)
  wchar_t text[16]{};
  const DWORD length =
      GetEnvironmentVariableW(L"SPRINT_CODER_NATIVE_SAFE_FS_VOLUME_FLAGS_CLEAR", text, 16);
  if (length > 0 && length < 16) *flags &= ~static_cast<DWORD>(wcstoul(text, nullptr, 16));
#endif
  return true;
}

bool PersistentAcls(HANDLE handle, bool* persistent) {
  DWORD flags = 0;
  if (!VolumeFlags(handle, &flags)) return false;
  *persistent = (flags & FILE_PERSISTENT_ACLS) != 0;
  return true;
}

// The access control a staged update carries over from the revision it replaces, so its new bytes
// are never readable by anyone the previous revision excluded (the POSIX backend keeps the mode).
// Same rules as ReplaceFileWithBackup: a volume without persistent ACLs has nothing to carry, a
// NULL DACL is never copied, the protection flag is preserved, and a current-user owner is kept.
// PredictStagedSecurity below states what this produces; every check compares against that.
struct CarriedSecurity {
  bool applies = false;
  PSECURITY_DESCRIPTOR source = nullptr;
  PACL dacl = nullptr;
  PSID owner = nullptr;
  SECURITY_INFORMATION information = 0;
  SECURITY_DESCRIPTOR creation{};
  std::vector<unsigned char> user_storage;
  CarriedSecurity() = default;
  CarriedSecurity(const CarriedSecurity&) = delete;
  CarriedSecurity& operator=(const CarriedSecurity&) = delete;
  ~CarriedSecurity() {
    if (source != nullptr) LocalFree(source);
  }
};

bool CaptureSourceSecurity(HANDLE source, CarriedSecurity* output) {
  bool persistent = false;
  if (!PersistentAcls(source, &persistent)) return false;
  if (!persistent) return true;
  PSID owner = nullptr;
  if (GetSecurityInfo(source, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                      &owner, nullptr, &output->dacl, nullptr, &output->source) != ERROR_SUCCESS)
    return false;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  // A NULL DACL grants full access to everyone. Never copy that fail-open state onto staged data.
  if (!GetSecurityDescriptorControl(output->source, &control, &revision) || output->dacl == nullptr)
    return false;
  const SECURITY_DESCRIPTOR_CONTROL carried = control & (SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED);
  output->information = DACL_SECURITY_INFORMATION | ((control & SE_DACL_PROTECTED) != 0
                                                         ? PROTECTED_DACL_SECURITY_INFORMATION
                                                         : UNPROTECTED_DACL_SECURITY_INFORMATION);
  // Like ReplaceFileWithBackup, compare with the token user: the owner is assigned explicitly here,
  // the user SID is always assignable, and a source owned by the default owner gets it anyway.
  PSID user = nullptr;
  if (!ProcessUserSid(&output->user_storage, &user)) return false;
  if (owner != nullptr && EqualSid(owner, user)) {
    output->owner = owner;
    output->information |= OWNER_SECURITY_INFORMATION;
  }
  if (!InitializeSecurityDescriptor(&output->creation, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorDacl(&output->creation, TRUE, output->dacl, FALSE) ||
      (output->owner != nullptr &&
       !SetSecurityDescriptorOwner(&output->creation, output->owner, FALSE)) ||
      !SetSecurityDescriptorControl(&output->creation, SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED,
                                    carried))
    return false;
  output->applies = true;
  return true;
}

// Refusals of an effect the Edit Saga could not undo exactly: what a file or directory holds
// beyond its unnamed data that an update's staged copy or an undone delete's re-created file would
// not get back. Each is decided read-only before the intent is journaled (the preflight), and again
// on the held objects before any byte changes; EFFECT_REFUSED tells the boundary nothing moved.
// Not refused, because it affects neither content, access nor confidentiality: timestamps,
// compression, sparseness, the object id, NOT_CONTENT_INDEXED on a delete, audit ACEs (which an
// unprivileged process cannot even read). UTF-8 for, in order: additional data streams, extended
// attributes, encryption, an explicit integrity label, its own access control (delete), access
// control that cannot be carried (update), access control changed during the update, hidden or
// system attributes (delete), a directory holding streams or extended attributes, and a file
// owned by someone else (update).
constexpr char kStreamsRefusal[] =
    "\xe3\x81\x93""\xe3\x81\xae""\xe3\x83\x95""\xe3\x82\xa1""\xe3\x82\xa4""\xe3\x83\xab"
    "\xe3\x81\xaf""\xe8\xbf\xbd""\xe5\x8a\xa0""\xe3\x81\xae""\xe3\x83\x87""\xe3\x83\xbc"
    "\xe3\x82\xbf""\xe3\x82\xb9""\xe3\x83\x88""\xe3\x83\xaa""\xe3\x83\xbc""\xe3\x83\xa0"
    "\xe3\x82\x92""\xe6\x8c\x81""\xe3\x81\xa4""\xe3\x81\x9f""\xe3\x82\x81""\xe3\x80\x81"
    "Windows ""\xe3\x81\xa7""\xe3\x81\xaf""\xe6\x9b\xb4""\xe6\x96\xb0""\xe3\x83\xbb"
    "\xe5\x89\x8a""\xe9\x99\xa4""\xe3\x81\xa7""\xe3\x81\x8d""\xe3\x81\xbe""\xe3\x81\x9b"
    "\xe3\x82\x93";
constexpr char kExtendedAttributesRefusal[] =
    "\xe3\x81\x93""\xe3\x81\xae""\xe3\x83\x95""\xe3\x82\xa1""\xe3\x82\xa4""\xe3\x83\xab"
    "\xe3\x81\xaf""\xe6\x8b\xa1""\xe5\xbc\xb5""\xe5\xb1\x9e""\xe6\x80\xa7""\xe3\x82\x92"
    "\xe6\x8c\x81""\xe3\x81\xa4""\xe3\x81\x9f""\xe3\x82\x81""\xe3\x80\x81""Windows "
    "\xe3\x81\xa7""\xe3\x81\xaf""\xe6\x9b\xb4""\xe6\x96\xb0""\xe3\x83\xbb""\xe5\x89\x8a"
    "\xe9\x99\xa4""\xe3\x81\xa7""\xe3\x81\x8d""\xe3\x81\xbe""\xe3\x81\x9b""\xe3\x82\x93";
constexpr char kEncryptionRefusal[] =
    "\xe3\x81\x93""\xe3\x81\xae""\xe3\x83\x95""\xe3\x82\xa1""\xe3\x82\xa4""\xe3\x83\xab"
    "\xe3\x81\xaf""\xe6\x9a\x97""\xe5\x8f\xb7""\xe5\x8c\x96""\xe3\x81\x95""\xe3\x82\x8c"
    "\xe3\x81\xa6""\xe3\x81\x84""\xe3\x82\x8b""\xe3\x81\x9f""\xe3\x82\x81""\xe3\x80\x81"
    "Windows ""\xe3\x81\xa7""\xe3\x81\xaf""\xe6\x9b\xb4""\xe6\x96\xb0""\xe3\x83\xbb"
    "\xe5\x89\x8a""\xe9\x99\xa4""\xe3\x81\xa7""\xe3\x81\x8d""\xe3\x81\xbe""\xe3\x81\x9b"
    "\xe3\x82\x93";
constexpr char kIntegrityLabelRefusal[] =
    "\xe3\x81\x93""\xe3\x81\xae""\xe3\x83\x95""\xe3\x82\xa1""\xe3\x82\xa4""\xe3\x83\xab"
    "\xe3\x81\xaf""\xe7\x8b\xac""\xe8\x87\xaa""\xe3\x81\xae""\xe6\x95\xb4""\xe5\x90\x88"
    "\xe6\x80\xa7""\xe3\x83\xac""\xe3\x83\x99""\xe3\x83\xab""\xe3\x82\x92""\xe6\x8c\x81"
    "\xe3\x81\xa4""\xe3\x81\x9f""\xe3\x82\x81""\xe3\x80\x81""Windows ""\xe3\x81\xa7"
    "\xe3\x81\xaf""\xe6\x9b\xb4""\xe6\x96\xb0""\xe3\x83\xbb""\xe5\x89\x8a""\xe9\x99\xa4"
    "\xe3\x81\xa7""\xe3\x81\x8d""\xe3\x81\xbe""\xe3\x81\x9b""\xe3\x82\x93";
constexpr char kAccessControlRefusal[] =
    "\xe3\x81\x93""\xe3\x81\xae""\xe3\x83\x95""\xe3\x82\xa1""\xe3\x82\xa4""\xe3\x83\xab"
    "\xe3\x81\xaf""\xe7\x8b\xac""\xe8\x87\xaa""\xe3\x81\xae""\xe3\x82\xa2""\xe3\x82\xaf"
    "\xe3\x82\xbb""\xe3\x82\xb9""\xe5\x88\xb6""\xe5\xbe\xa1""\xe3\x82\x92""\xe6\x8c\x81"
    "\xe3\x81\xa4""\xe3\x81\x9f""\xe3\x82\x81""\xe3\x80\x81""Windows ""\xe3\x81\xa7"
    "\xe3\x81\xaf""\xe5\x89\x8a""\xe9\x99\xa4""\xe3\x81\xa7""\xe3\x81\x8d""\xe3\x81\xbe"
    "\xe3\x81\x9b""\xe3\x82\x93";
constexpr char kAccessControlUpdateRefusal[] =
    "\xe3\x81\x93""\xe3\x81\xae""\xe3\x83\x95""\xe3\x82\xa1""\xe3\x82\xa4""\xe3\x83\xab"
    "\xe3\x81\xae""\xe3\x82\xa2""\xe3\x82\xaf""\xe3\x82\xbb""\xe3\x82\xb9""\xe5\x88\xb6"
    "\xe5\xbe\xa1""\xe3\x81\xaf""\xe5\xbc\x95""\xe3\x81\x8d""\xe7\xb6\x99""\xe3\x81\x92"
    "\xe3\x81\xaa""\xe3\x81\x84""\xe3\x81\x9f""\xe3\x82\x81""\xe3\x80\x81""Windows "
    "\xe3\x81\xa7""\xe3\x81\xaf""\xe6\x9b\xb4""\xe6\x96\xb0""\xe3\x81\xa7""\xe3\x81\x8d"
    "\xe3\x81\xbe""\xe3\x81\x9b""\xe3\x82\x93";
constexpr char kAccessControlChangedRefusal[] =
    "\xe3\x81\x93""\xe3\x81\xae""\xe3\x83\x95""\xe3\x82\xa1""\xe3\x82\xa4""\xe3\x83\xab"
    "\xe3\x81\xae""\xe3\x82\xa2""\xe3\x82\xaf""\xe3\x82\xbb""\xe3\x82\xb9""\xe5\x88\xb6"
    "\xe5\xbe\xa1""\xe3\x81\x8c""\xe6\x9b\xb4""\xe6\x96\xb0""\xe3\x81\xae""\xe9\x80\x94"
    "\xe4\xb8\xad""\xe3\x81\xa7""\xe5\xa4\x89""\xe3\x82\x8f""\xe3\x81\xa3""\xe3\x81\x9f"
    "\xe3\x81\x9f""\xe3\x82\x81""\xe3\x80\x81""Windows ""\xe3\x81\xa7""\xe3\x81\xaf"
    "\xe6\x9b\xb4""\xe6\x96\xb0""\xe3\x81\xa7""\xe3\x81\x8d""\xe3\x81\xbe""\xe3\x81\x9b"
    "\xe3\x82\x93";
constexpr char kHiddenSystemRefusal[] =
    "\xe3\x81\x93""\xe3\x81\xae""\xe3\x83\x95""\xe3\x82\xa1""\xe3\x82\xa4""\xe3\x83\xab"
    "\xe3\x81\xaf""\xe9\x9a\xa0""\xe3\x81\x97""\xe3\x81\xbe""\xe3\x81\x9f""\xe3\x81\xaf"
    "\xe3\x82\xb7""\xe3\x82\xb9""\xe3\x83\x86""\xe3\x83\xa0""\xe5\xb1\x9e""\xe6\x80\xa7"
    "\xe3\x82\x92""\xe6\x8c\x81""\xe3\x81\xa4""\xe3\x81\x9f""\xe3\x82\x81""\xe3\x80\x81"
    "Windows ""\xe3\x81\xa7""\xe3\x81\xaf""\xe5\x89\x8a""\xe9\x99\xa4""\xe3\x81\xa7"
    "\xe3\x81\x8d""\xe3\x81\xbe""\xe3\x81\x9b""\xe3\x82\x93";
constexpr char kOwnerUpdateRefusal[] =
    "\xe3\x81\x93""\xe3\x81\xae""\xe3\x83\x95""\xe3\x82\xa1""\xe3\x82\xa4""\xe3\x83\xab"
    "\xe3\x81\xaf""\xe6\x89\x80""\xe6\x9c\x89""\xe8\x80\x85""\xe3\x81\x8c""\xe7\x95\xb0"
    "\xe3\x81\xaa""\xe3\x82\x8b""\xe3\x81\x9f""\xe3\x82\x81""\xe3\x80\x81""Windows "
    "\xe3\x81\xa7""\xe3\x81\xaf""\xe6\x9b\xb4""\xe6\x96\xb0""\xe3\x81\xa7""\xe3\x81\x8d"
    "\xe3\x81\xbe""\xe3\x81\x9b""\xe3\x82\x93";
constexpr char kDirectoryDataRefusal[] =
    "\xe3\x81\x93""\xe3\x81\xae""\xe3\x83\x95""\xe3\x82\xa9""\xe3\x83\xab""\xe3\x83\x80"
    "\xe3\x81\xaf""\xe8\xbf\xbd""\xe5\x8a\xa0""\xe3\x81\xae""\xe3\x83\x87""\xe3\x83\xbc"
    "\xe3\x82\xbf""\xe3\x82\xb9""\xe3\x83\x88""\xe3\x83\xaa""\xe3\x83\xbc""\xe3\x83\xa0"
    "\xe3\x81\xbe""\xe3\x81\x9f""\xe3\x81\xaf""\xe6\x8b\xa1""\xe5\xbc\xb5""\xe5\xb1\x9e"
    "\xe6\x80\xa7""\xe3\x82\x92""\xe6\x8c\x81""\xe3\x81\xa4""\xe3\x81\x9f""\xe3\x82\x81"
    "\xe3\x80\x81""Windows ""\xe3\x81\xa7""\xe3\x81\xaf""\xe5\x89\x8a""\xe9\x99\xa4"
    "\xe3\x81\xa7""\xe3\x81\x8d""\xe3\x81\xbe""\xe3\x81\x9b""\xe3\x82\x93";

using NtQueryInformationFileFn = NTSTATUS(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG,
                                                  FILE_INFORMATION_CLASS);
constexpr int kFileEaInformationClass = 7;
constexpr wchar_t kOwnershipStreamEntry[] = L":sprint-coder.mkdir-owner:$DATA";

// Whether the object carries a data stream besides its unnamed one (and, for a directory, its
// ownership stream). An update writes only the unnamed stream and an undone delete re-creates only
// that, so a named stream (metadata, a Zone.Identifier) would be lost. A volume without named
// streams has none; on one that has them, a failed query is refused like a stream.
bool HasNamedDataStreams(HANDLE object, const wchar_t* allowed, bool* named) {
  DWORD flags = 0;
  if (!VolumeFlags(object, &flags)) return false;
  if ((flags & FILE_NAMED_STREAMS) == 0) {
    *named = false;
    return true;
  }
  std::vector<uint64_t> buffer(512);
  while (!GetFileInformationByHandleEx(object, FileStreamInfo, buffer.data(),
                                       static_cast<DWORD>(buffer.size() * sizeof(uint64_t)))) {
    const DWORD error = GetLastError();
    if (error == ERROR_HANDLE_EOF) {
      *named = false;
      return true;
    }
    if (error != ERROR_MORE_DATA || buffer.size() >= 65536) return false;
    buffer.resize(buffer.size() * 4);
  }
  for (auto* entry = reinterpret_cast<FILE_STREAM_INFO*>(buffer.data());;
       entry = reinterpret_cast<FILE_STREAM_INFO*>(reinterpret_cast<uint8_t*>(entry) +
                                                   entry->NextEntryOffset)) {
    const std::wstring name(entry->StreamName, entry->StreamNameLength / sizeof(wchar_t));
    if (name != L"::$DATA" && (allowed == nullptr || name != allowed)) {
      *named = true;
      return true;
    }
    if (entry->NextEntryOffset == 0) break;
  }
  *named = false;
  return true;
}

// Extended attributes (including WSL metadata) are not copied by either the stage or a re-create.
// A volume without them has none.
bool HasExtendedAttributes(HANDLE object, bool* present) {
  DWORD flags = 0;
  if (!VolumeFlags(object, &flags)) return false;
  if ((flags & FILE_SUPPORTS_EXTENDED_ATTRIBUTES) == 0) {
    *present = false;
    return true;
  }
  static const auto query = reinterpret_cast<NtQueryInformationFileFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationFile"));
  if (query == nullptr) return false;
  struct {
    ULONG EaSize;
  } information{};
  IO_STATUS_BLOCK status{};
  if (query(object, &status, &information, sizeof(information),
            static_cast<FILE_INFORMATION_CLASS>(kFileEaInformationClass)) < 0)
    return false;
  *present = information.EaSize != 0;
  return true;
}

// Data a delete or discard would destroy along with the object, or nullptr: a named stream or
// extended attributes nobody approved. The directory's own ownership stream is `allowed`.
const char* UnapprovedDataReason(HANDLE object, const wchar_t* allowed = nullptr) {
  bool present = true;
  if (!HasNamedDataStreams(object, allowed, &present) || present) return kStreamsRefusal;
  if (!HasExtendedAttributes(object, &present) || present) return kExtendedAttributesRefusal;
  return nullptr;
}

// Whether two DACLs grant the same access: the same entries in the same order. The inherited flag
// only records where an entry came from, which a protected re-application does not keep.
bool SameAccess(PACL left, PACL right) {
  if (left == nullptr || right == nullptr || left->AceCount != right->AceCount) return false;
  for (DWORD index = 0; index < left->AceCount; ++index) {
    void* first = nullptr;
    void* second = nullptr;
    if (!GetAce(left, index, &first) || !GetAce(right, index, &second)) return false;
    const auto* first_header = static_cast<ACE_HEADER*>(first);
    const auto* second_header = static_cast<ACE_HEADER*>(second);
    if (first_header->AceType != second_header->AceType ||
        first_header->AceSize != second_header->AceSize ||
        (first_header->AceFlags & ~INHERITED_ACE) != (second_header->AceFlags & ~INHERITED_ACE) ||
        std::memcmp(first_header + 1, second_header + 1,
                    first_header->AceSize - sizeof(ACE_HEADER)) != 0)
      return false;
  }
  return true;
}

// A DACL together with its protection and owner, as a file carries them.
struct DaclFacts {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PACL dacl = nullptr;
  PSID owner = nullptr;
  bool protected_dacl = false;
  DaclFacts() = default;
  DaclFacts(const DaclFacts&) = delete;
  DaclFacts& operator=(const DaclFacts&) = delete;
  ~DaclFacts() {
    if (descriptor != nullptr) LocalFree(descriptor);
  }
};

bool ReadDacl(HANDLE handle, SECURITY_INFORMATION extra, DaclFacts* output) {
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | extra,
                      (extra & OWNER_SECURITY_INFORMATION) != 0 ? &output->owner : nullptr,
                      nullptr, &output->dacl, nullptr, &output->descriptor) != ERROR_SUCCESS ||
      !GetSecurityDescriptorControl(output->descriptor, &control, &revision))
    return false;
  output->protected_dacl = (control & SE_DACL_PROTECTED) != 0;
  return true;
}

// An explicit integrity label is lost by both a stage and a re-create; one inherited from the
// parent is given to the new file again.
bool HasExplicitIntegrityLabel(HANDLE object, bool* labelled) {
  PACL sacl = nullptr;
  PSECURITY_DESCRIPTOR raw = nullptr;
  if (GetSecurityInfo(object, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, nullptr, nullptr,
                      nullptr, &sacl, &raw) != ERROR_SUCCESS)
    return false;
  const std::unique_ptr<void, decltype(&LocalFree)> descriptor(raw, &LocalFree);
  *labelled = false;
  for (DWORD index = 0; sacl != nullptr && index < sacl->AceCount; ++index) {
    void* ace = nullptr;
    if (!GetAce(sacl, index, &ace)) return false;
    const auto* header = static_cast<ACE_HEADER*>(ace);
    if (header->AceType == SYSTEM_MANDATORY_LABEL_ACE_TYPE &&
        (header->AceFlags & INHERITED_ACE) == 0)
      *labelled = true;
  }
  return true;
}

// The owner, DACL and protection a new file gets: what a staged update is given, or what an undone
// delete re-creates. One prediction, compared against by the preflight, by staging before it
// writes, and by the apply step before it publishes, so the three can never disagree.
struct PredictedSecurity {
  bool applies = false;
  bool protected_dacl = false;
  std::vector<uint64_t> dacl_storage;
  PACL dacl = nullptr;
  std::vector<unsigned char> owner_storage;
  PSID owner = nullptr;
};

bool CopySidInto(PSID sid, std::vector<unsigned char>* storage, PSID* output) {
  storage->resize(GetLengthSid(sid));
  if (!CopySid(static_cast<DWORD>(storage->size()), storage->data(), sid)) return false;
  *output = storage->data();
  return true;
}

// Copies `dacl`, keeping only the entries `keep` selects and clearing their inherited flag when
// `strip_inherited` is set.
bool CopyAcl(PACL dacl, bool (*keep)(const ACE_HEADER*), bool strip_inherited,
             std::vector<uint64_t>* storage, PACL* output) {
  storage->assign(dacl->AclSize / sizeof(uint64_t) + 1, 0);
  auto* acl = reinterpret_cast<PACL>(storage->data());
  if (!InitializeAcl(acl, dacl->AclSize, dacl->AclRevision)) return false;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* ace = nullptr;
    if (!GetAce(dacl, index, &ace)) return false;
    const auto* header = static_cast<ACE_HEADER*>(ace);
    if (!keep(header)) continue;
    std::vector<uint8_t> entry(static_cast<const uint8_t*>(ace),
                               static_cast<const uint8_t*>(ace) + header->AceSize);
    if (strip_inherited) reinterpret_cast<ACE_HEADER*>(entry.data())->AceFlags &= ~INHERITED_ACE;
    if (!AddAce(acl, dacl->AclRevision, MAXDWORD, entry.data(), header->AceSize)) return false;
  }
  *output = acl;
  return true;
}

// The DACL a file created in `parent` with owner `owner` and its own `explicit_dacl` (nullptr for
// none) gets: the explicit entries, then what the parent passes down, CREATOR OWNER resolved to
// `owner`.
bool InheritIn(HANDLE parent, PSID owner, PACL explicit_dacl, PredictedSecurity* output) {
  HANDLE raw = INVALID_HANDLE_VALUE;
  // READ_CONTROL is outside share-mode checks, so this reopens the pinned parent itself.
  if (OpenRelative(parent, std::wstring(), READ_CONTROL | SYNCHRONIZE, kObserveShare, FILE_OPEN,
                   FILE_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &raw) < 0)
    return false;
  const OwnedHandle parent_security(raw);
  PSECURITY_DESCRIPTOR parent_raw = nullptr;
  if (GetSecurityInfo(parent_security.get(), SE_FILE_OBJECT,
                      OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION |
                          DACL_SECURITY_INFORMATION,
                      nullptr, nullptr, nullptr, nullptr, &parent_raw) != ERROR_SUCCESS)
    return false;
  const std::unique_ptr<void, decltype(&LocalFree)> parent_descriptor(parent_raw, &LocalFree);
  SECURITY_DESCRIPTOR creator{};
  if (!InitializeSecurityDescriptor(&creator, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&creator, owner, FALSE) ||
      (explicit_dacl != nullptr && !SetSecurityDescriptorDacl(&creator, TRUE, explicit_dacl, FALSE)))
    return false;
  HANDLE token_raw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token_raw)) return false;
  const OwnedHandle token(token_raw);
  GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE,
                          FILE_ALL_ACCESS};
  PSECURITY_DESCRIPTOR created = nullptr;
  if (!CreatePrivateObjectSecurityEx(parent_raw, &creator, &created, nullptr, FALSE,
                                     SEF_DACL_AUTO_INHERIT | SEF_AVOID_PRIVILEGE_CHECK |
                                         SEF_AVOID_OWNER_CHECK,
                                     token.get(), &mapping))
    return false;
  BOOL present = FALSE;
  BOOL defaulted = FALSE;
  PACL created_dacl = nullptr;
  const bool copied =
      GetSecurityDescriptorDacl(created, &present, &created_dacl, &defaulted) && present &&
      created_dacl != nullptr &&
      CopyAcl(
          created_dacl, [](const ACE_HEADER*) { return true; }, false, &output->dacl_storage,
          &output->dacl);
  DestroyPrivateObjectSecurity(&created);
  return copied;
}

// What CaptureSourceSecurity and the protected or unprotected re-application give a staged update
// of `source`: owned by the user when the source is, otherwise by the default owner; a protected
// DACL as it stands without the inherited flags, an unprotected one as its own entries plus what
// the current parent passes down. A reason is returned instead when that cannot match the source.
const char* PredictStagedSecurity(HANDLE source, HANDLE parent, PredictedSecurity* output) {
  bool persistent = false;
  if (!PersistentAcls(source, &persistent)) return kAccessControlUpdateRefusal;
  if (!persistent) return nullptr;
  DaclFacts actual;
  std::vector<unsigned char> user_storage, default_owner_storage;
  PSID user = nullptr;
  PSID default_owner = nullptr;
  // A NULL DACL (full access for everyone) is never carried.
  if (!ReadDacl(source, OWNER_SECURITY_INFORMATION, &actual) || actual.dacl == nullptr ||
      actual.owner == nullptr || !ProcessUserSid(&user_storage, &user) ||
      !ProcessDefaultOwnerSid(&default_owner_storage, &default_owner))
    return kAccessControlUpdateRefusal;
  // Handing a file owned by someone else (an Administrators-owned one, say) to the user would let
  // the user rewrite its DACL, so such an update is refused rather than carried.
  if (!EqualSid(actual.owner, user) && !EqualSid(actual.owner, default_owner))
    return kOwnerUpdateRefusal;
  if (!CopySidInto(actual.owner, &output->owner_storage, &output->owner))
    return kAccessControlUpdateRefusal;
  output->applies = true;
  output->protected_dacl = actual.protected_dacl;
  if (actual.protected_dacl)
    return CopyAcl(
               actual.dacl, [](const ACE_HEADER*) { return true; }, true, &output->dacl_storage,
               &output->dacl)
               ? nullptr
               : kAccessControlUpdateRefusal;
  std::vector<uint64_t> explicit_storage;
  PACL explicit_dacl = nullptr;
  return CopyAcl(
             actual.dacl,
             [](const ACE_HEADER* header) { return (header->AceFlags & INHERITED_ACE) == 0; },
             false, &explicit_storage, &explicit_dacl) &&
                 InheritIn(parent, output->owner, explicit_dacl, output)
             ? nullptr
             : kAccessControlUpdateRefusal;
}

// What an undone delete re-creates in `parent`: owned by the default owner, with only what the
// parent passes down.
bool PredictRecreatedSecurity(HANDLE parent, PredictedSecurity* output) {
  std::vector<unsigned char> default_owner_storage;
  PSID default_owner = nullptr;
  if (!ProcessDefaultOwnerSid(&default_owner_storage, &default_owner) ||
      !CopySidInto(default_owner, &output->owner_storage, &output->owner))
    return false;
  output->applies = true;
  output->protected_dacl = false;
  return InheritIn(parent, output->owner, nullptr, output);
}

// Whether a file's owner, DACL and protection are the predicted ones.
bool MatchesPrediction(HANDLE file, const PredictedSecurity& prediction) {
  if (!prediction.applies) return true;
  DaclFacts actual;
  return ReadDacl(file, OWNER_SECURITY_INFORMATION, &actual) && actual.dacl != nullptr &&
         actual.owner != nullptr && EqualSid(actual.owner, prediction.owner) &&
         actual.protected_dacl == prediction.protected_dacl &&
         SameAccess(actual.dacl, prediction.dacl);
}

// The access-control part of the refusal: whether the source keeps its owner and DACL through the
// effect. `prediction` receives what a staged update must be given.
const char* AccessControlReason(bool deleting, HANDLE security, HANDLE parent,
                                PredictedSecurity* prediction) {
  if (!deleting) {
    if (const char* reason = PredictStagedSecurity(security, parent, prediction)) return reason;
    return MatchesPrediction(security, *prediction) ? nullptr : kAccessControlUpdateRefusal;
  }
  bool persistent = false;
  if (!PersistentAcls(security, &persistent)) return kAccessControlRefusal;
  if (!persistent) return nullptr;
  return PredictRecreatedSecurity(parent, prediction) && MatchesPrediction(security, *prediction)
             ? nullptr
             : kAccessControlRefusal;
}

// Why an update or delete of this file could not be undone exactly, or nullptr. `content` reads
// the streams and extended attributes, `security` (READ_CONTROL, the same object) the
// descriptor, `parent` is pinned. `prediction`, when given, receives the staged update's security.
const char* IrreversibleEffectReason(bool deleting, HANDLE content, HANDLE security, HANDLE parent,
                                     PredictedSecurity* prediction = nullptr) {
  if (const char* reason = UnapprovedDataReason(content)) return reason;
  FileFacts facts;
  bool labelled = true;
  if (!QueryFacts(content, &facts) || (facts.attributes & FILE_ATTRIBUTE_ENCRYPTED) != 0)
    return kEncryptionRefusal;
  if (!HasExplicitIntegrityLabel(security, &labelled) || labelled) return kIntegrityLabelRefusal;
  if (deleting && (facts.attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) != 0)
    return kHiddenSystemRefusal;
  PredictedSecurity local;
  return AccessControlReason(deleting, security, parent, prediction == nullptr ? &local : prediction);
}

// Attributes a staged update carries over from the revision it replaces (READONLY follows the
// sealed mode instead).
constexpr DWORD kCarriedAttributes =
    FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED;

// Whether a directory holds data of its own that removing it would destroy: a named stream other
// than its ownership stream, or extended attributes.
bool DirectoryCarriesData(HANDLE directory) {
  return UnapprovedDataReason(directory, kOwnershipStreamEntry) != nullptr;
}

// Opens the descriptor of a held endpoint for reading and proves it is the same object.
bool OpenHeldSecurity(HANDLE parent, const std::wstring& leaf, HANDLE held, OwnedHandle* output) {
  HANDLE raw = INVALID_HANDLE_VALUE;
  if (OpenRelative(parent, leaf, READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE, kObserveShare,
                   FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &raw) < 0)
    return false;
  OwnedHandle security(raw);
  FileFacts held_facts, security_facts;
  if (!QueryFacts(held, &held_facts) || !QueryFacts(security.get(), &security_facts) ||
      !SameObject(held_facts, security_facts))
    return false;
  *output = std::move(security);
  return true;
}

bool StoreFence(HANDLE lock, uint64_t fence) {
  const std::string text = std::to_string(fence);
  LARGE_INTEGER start{};
  DWORD written = 0;
  return SetFilePointerEx(lock, start, nullptr, FILE_BEGIN) && SetEndOfFile(lock) &&
         WriteFile(lock, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) &&
         written == text.size() && FlushFileBuffers(lock);
}

enum class SwapPhase { kNone, kSourceParked, kAuxiliaryParked };

// The endpoints of an intent as the Edit Saga sees them. An update runs as three no-replace renames
// (source -> swap, staged -> source, swap -> auxiliary); a process that dies between them leaves
// exactly one revision under the swap name, which this view reports at the endpoint it logically
// occupies. The next applyIntentEffect or cleanupIntentAuxiliary finishes that sequence, so a
// restart converges on the sealed post-image instead of reporting drift.
struct IntentView {
  EndpointRevision source;
  EndpointRevision destination;
  EndpointRevision auxiliary;
  SwapPhase phase = SwapPhase::kNone;
};

bool ObserveInto(const std::shared_ptr<MutationSession>& session,
                 const std::vector<std::wstring>& segments, EndpointRevision* revision,
                 Failure* failure) {
  switch (ObserveEndpoint(session, segments, revision)) {
    case EndpointResult::kAbsent:
      *revision = EndpointRevision{};
      return true;
    case EndpointResult::kPresent:
      return true;
    case EndpointResult::kUnsafe:
      return Fail(failure, "UNSAFE_PATH", "NativeSafeFs endpoint is unsafe");
    default:
      return Fail(failure, "NATIVE_FAILURE", "NativeSafeFs endpoint observation failed");
  }
}

bool ObserveIntentView(const std::shared_ptr<MutationSession>& session,
                       const std::vector<std::wstring>& source,
                       const std::vector<std::wstring>* destination,
                       const std::vector<std::wstring>* auxiliary, IntentView* view,
                       Failure* failure) {
  *view = IntentView{};
  if (!ObserveInto(session, source, &view->source, failure) ||
      (destination != nullptr && !ObserveInto(session, *destination, &view->destination, failure)) ||
      (auxiliary != nullptr && !ObserveInto(session, *auxiliary, &view->auxiliary, failure)))
    return false;
  if (auxiliary == nullptr || !IsTemporaryLeaf(auxiliary->back())) return true;
  std::vector<std::wstring> swap = *auxiliary;
  swap.back() = SwapLeafFor(auxiliary->back());
  EndpointRevision parked;
  if (!ObserveInto(session, swap, &parked, failure)) return false;
  if (!parked.present) return true;
  if (ParentOf(source) == ParentOf(*auxiliary) && !view->source.present &&
      view->auxiliary.present) {
    view->source = std::move(parked);
    view->phase = SwapPhase::kSourceParked;
    return true;
  }
  if (ParentOf(source) == ParentOf(*auxiliary) && view->source.present &&
      !view->auxiliary.present) {
    view->auxiliary = std::move(parked);
    view->phase = SwapPhase::kAuxiliaryParked;
    return true;
  }
  return Fail(failure, "UNSAFE_PATH", "NativeSafeFs observed an indeterminate interrupted update");
}

struct EffectInput {
  std::string kind;
  std::vector<std::wstring> source;
  std::vector<std::wstring> destination;
  std::vector<std::wstring> auxiliary;
  bool has_destination = false;
  bool has_auxiliary = false;
  EndpointRevision expected_source;
  EndpointRevision expected_destination;
  EndpointRevision expected_auxiliary;
};

// The same shapes the POSIX backend accepts, plus the one Windows relies on: the staged artifact or
// tombstone shares the source's parent, so every update rename stays inside one pinned directory.
bool EffectShapeIsValid(const EffectInput& input) {
  if (input.source.empty() || input.expected_destination.present) return false;
  const bool auxiliary_beside_source =
      input.has_auxiliary && ParentOf(input.auxiliary) == ParentOf(input.source);
  if (input.kind == "add")
    return !input.expected_source.present && !input.has_destination && auxiliary_beside_source &&
           input.expected_auxiliary.present && IsTemporaryLeaf(input.auxiliary.back());
  if (input.kind == "update")
    return input.expected_source.present && !input.has_destination && auxiliary_beside_source &&
           input.expected_auxiliary.present && IsTemporaryLeaf(input.auxiliary.back());
  if (input.kind == "delete")
    return input.expected_source.present && !input.has_destination && auxiliary_beside_source &&
           !input.expected_auxiliary.present &&
           IsReservedLeaf(input.auxiliary.back(), kTombstonePrefix);
  if (input.kind == "rename")
    return input.expected_source.present && input.has_destination && !input.has_auxiliary &&
           !input.expected_auxiliary.present;
  return false;
}

bool EffectObservationIsValid(const EffectInput& input, const IntentView& view) {
  const EndpointRevision absent;
  if (view.phase != SwapPhase::kNone) return false;
  if (input.kind == "add")
    return Matches(view.source, input.expected_auxiliary) && Matches(view.destination, absent) &&
           Matches(view.auxiliary, absent);
  if (input.kind == "update")
    return Matches(view.source, input.expected_auxiliary) && Matches(view.destination, absent) &&
           Matches(view.auxiliary, input.expected_source);
  if (input.kind == "delete")
    return Matches(view.source, absent) && Matches(view.destination, absent) &&
           Matches(view.auxiliary, input.expected_source);
  return Matches(view.source, absent) && Matches(view.destination, input.expected_source) &&
         Matches(view.auxiliary, absent);
}

bool FlushPinned(const PinnedDirectory& first, const PinnedDirectory* second, Failure* failure) {
  if (!FlushFileBuffers(first.get()) ||
      (second != nullptr && !SameObject(first.facts, second->facts) &&
       !FlushFileBuffers(second->get())))
    return Fail(failure, "NATIVE_FAILURE", "NativeSafeFs mutation parent flush failed");
  return true;
}

// add (staged -> source), delete (source -> tombstone) and rename (source -> destination): one
// no-replace rename of a held, re-verified file into an absent name.
bool ApplyMove(const std::shared_ptr<MutationSession>& session,
               const std::vector<std::wstring>& from, const EndpointRevision& expected,
               const std::vector<std::wstring>& to, bool deleting, Failure* failure) {
  PinnedDirectory from_parent, to_parent;
  if (!PinDirectoryPath(session->root.get(), ParentOf(from), true, &from_parent) ||
      !PinDirectoryPath(session->root.get(), ParentOf(to), true, &to_parent))
    return Fail(failure, "UNSAFE_PATH", "NativeSafeFs mutation parent is unsafe");
  EndpointRevision held_revision;
  OwnedHandle held;
  if (HoldEndpoint(*session, from_parent.get(), from.back(), &held_revision, &held) !=
          EndpointResult::kPresent ||
      !SameRevision(held_revision, expected))
    return Fail(failure, "UNSAFE_PATH", "NativeSafeFs effect changed before kernel call");
  if (deleting) {
    OwnedHandle security;
    const char* reason =
        !OpenHeldSecurity(from_parent.get(), from.back(), held.get(), &security)
            ? kAccessControlRefusal
            : IrreversibleEffectReason(true, held.get(), security.get(), from_parent.get());
    if (reason != nullptr) return Fail(failure, "EFFECT_REFUSED", reason);
  }
  if (ProbeName(to_parent.get(), to.back()) != EndpointResult::kAbsent)
    return Fail(failure, "UNSAFE_PATH", "NativeSafeFs effect target is not absent");
  if (!SessionCurrent(session))
    return Fail(failure, "STALE_SESSION", "NativeSafeFs session was invalidated before effect");
  const NTSTATUS status = MoveHandleNoReplace(held.get(), to_parent.get(), to.back());
  if (status < 0) return MoveFailure(status, failure);
  held.reset();
  return FlushPinned(to_parent, &from_parent, failure);
}

// update: park the previous revision under the swap name, move the staged artifact onto the
// source, then move the parked revision onto the auxiliary name, so the old bytes stay reachable
// for compensation exactly as POSIX's exchange leaves them.
bool ApplyUpdate(const std::shared_ptr<MutationSession>& session, const EffectInput& input,
                 SwapPhase phase, Failure* failure) {
  PinnedDirectory parent;
  if (!PinDirectoryPath(session->root.get(), ParentOf(input.source), true, &parent))
    return Fail(failure, "UNSAFE_PATH", "NativeSafeFs mutation parent is unsafe");
  const std::wstring& source_leaf = input.source.back();
  const std::wstring& auxiliary_leaf = input.auxiliary.back();
  const std::wstring swap_leaf = SwapLeafFor(auxiliary_leaf);
  const bool resuming = phase == SwapPhase::kSourceParked;
  EndpointRevision previous_revision, staged_revision;
  OwnedHandle previous, staged;
  if (HoldEndpoint(*session, parent.get(), resuming ? swap_leaf : source_leaf, &previous_revision,
                   &previous) != EndpointResult::kPresent ||
      !SameRevision(previous_revision, input.expected_source) ||
      HoldEndpoint(*session, parent.get(), auxiliary_leaf, &staged_revision, &staged) !=
          EndpointResult::kPresent ||
      !SameRevision(staged_revision, input.expected_auxiliary))
    return Fail(failure, "UNSAFE_PATH", "NativeSafeFs update endpoints changed before kernel call");
  // The preflight's checks, repeated on the held objects immediately before the first rename: the
  // previous revision may have gained a stream or a stricter DACL since it was staged beside.
  // Once the previous revision is parked, something has moved, so a resumed update never answers
  // EFFECT_REFUSED.
  OwnedHandle previous_security, staged_security;
  PredictedSecurity prediction;
  const char* reason =
      !OpenHeldSecurity(parent.get(), resuming ? swap_leaf : source_leaf, previous.get(),
                        &previous_security) ||
              !OpenHeldSecurity(parent.get(), auxiliary_leaf, staged.get(), &staged_security)
          ? kAccessControlChangedRefusal
          : IrreversibleEffectReason(false, previous.get(), previous_security.get(), parent.get(),
                                     &prediction);
  if (reason == nullptr && !MatchesPrediction(staged_security.get(), prediction))
    reason = kAccessControlChangedRefusal;
  if (reason != nullptr) return Fail(failure, resuming ? "UNSAFE_PATH" : "EFFECT_REFUSED", reason);
  if (ProbeName(parent.get(), resuming ? source_leaf : swap_leaf) != EndpointResult::kAbsent)
    return Fail(failure, "UNSAFE_PATH", "NativeSafeFs update swap name is occupied");
  if (!SessionCurrent(session))
    return Fail(failure, "STALE_SESSION", "NativeSafeFs session was invalidated before effect");
  NTSTATUS status = 0;
  if (!resuming) {
    status = MoveHandleNoReplace(previous.get(), parent.get(), swap_leaf);
    if (status < 0) return MoveFailure(status, failure);
  }
  status = MoveHandleNoReplace(staged.get(), parent.get(), source_leaf);
  if (status < 0) {
    // The staged artifact never moved; put the previous revision back under its own name.
    MoveHandleNoReplace(previous.get(), parent.get(), source_leaf);
    FlushFileBuffers(parent.get());
    return MoveFailure(status, failure);
  }
  status = MoveHandleNoReplace(previous.get(), parent.get(), auxiliary_leaf);
  if (status < 0) {
    // The new revision is published and the previous one stays parked under the swap name, which
    // every later observation of this intent resolves to its auxiliary endpoint.
    FlushFileBuffers(parent.get());
    return MoveFailure(status, failure);
  }
  return FlushPinned(parent, nullptr, failure);
}

bool ReadEffectInput(napi_env env, napi_value input, EffectInput* output) {
  bool destination_null = false, auxiliary_null = false;
  if (!NamedString(env, input, "kind", &output->kind) ||
      !ReadSegments(env, input, "sourceSegments", false, &output->source) ||
      !ReadNullableSegments(env, input, "destinationSegments", &destination_null,
                            &output->destination) ||
      !ReadNullableSegments(env, input, "auxiliarySegments", &auxiliary_null, &output->auxiliary) ||
      !ReadExpectation(env, input, "expectedSource", &output->expected_source) ||
      !ReadExpectation(env, input, "expectedDestination", &output->expected_destination) ||
      !ReadExpectation(env, input, "expectedAuxiliary", &output->expected_auxiliary))
    return false;
  output->has_destination = !destination_null;
  output->has_auxiliary = !auxiliary_null;
  return true;
}

// Directory ownership. The Windows counterparts of the POSIX contract: a created directory carries
// its ownership token in a named stream (the xattr) and, until its Saga step completes, a marker file
// holding the same token.

struct HeldDirectory {
  OwnedHandle handle;
  FileFacts facts;
};

EndpointResult HoldDirectory(HANDLE parent, const std::wstring& leaf, ACCESS_MASK extra_access,
                             ULONG share, HeldDirectory* output) {
  HANDLE raw = INVALID_HANDLE_VALUE;
  const NTSTATUS status =
      OpenRelative(parent, leaf, kDirectoryReadAccess | extra_access, share, FILE_OPEN,
                   FILE_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &raw);
  if (status < 0) return OpenStatusResult(status);
  output->handle.reset(raw);
  if (!QueryFacts(raw, &output->facts)) return EndpointResult::kFailure;
  if ((output->facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      (output->facts.attributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
    return EndpointResult::kUnsafe;
  return EndpointResult::kPresent;
}

bool ReadTokenFrom(HANDLE handle, std::string* token) {
  FileFacts facts;
  std::vector<uint8_t> bytes;
  if (!QueryFacts(handle, &facts) || facts.size != 64 || !ReadAll(handle, 64, &bytes))
    return false;
  *token = std::string(bytes.begin(), bytes.end());
  return IsLowerHex(*token, 64);
}

// The stream opens share delete: NTFS checks DELETE sharing across every stream of a file, and the
// directory handle a caller holds while it moves or removes the directory carries DELETE access.
bool ReadOwnershipToken(HANDLE directory, std::string* token) {
  HANDLE raw = INVALID_HANDLE_VALUE;
  if (OpenRelative(directory, kOwnershipStream, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                   kObserveShare, FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL,
                   &raw) < 0)
    return false;
  OwnedHandle stream(raw);
  return ReadTokenFrom(stream.get(), token);
}

bool WriteTokenTo(HANDLE handle, const std::string& token) {
  DWORD written = 0;
  return WriteFile(handle, token.data(), static_cast<DWORD>(token.size()), &written, nullptr) &&
         written == token.size() && FlushFileBuffers(handle);
}

NTSTATUS WriteOwnershipToken(HANDLE directory, const std::string& token) {
  HANDLE raw = INVALID_HANDLE_VALUE;
  const NTSTATUS status =
      OpenRelative(directory, kOwnershipStream, FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                   FILE_SHARE_DELETE, FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL,
                   &raw);
  if (status < 0) return status;
  OwnedHandle stream(raw);
  return WriteTokenTo(stream.get(), token) ? 0 : static_cast<NTSTATUS>(0xC0000001L);
}

// Opens the marker as a unique regular file. `delete_access` also lets the caller remove it.
bool HoldMarker(HANDLE directory, const std::wstring& marker_leaf, bool delete_access,
                std::string* token, OwnedHandle* held) {
  HANDLE raw = INVALID_HANDLE_VALUE;
  if (OpenRelative(directory, marker_leaf,
                   FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE |
                       (delete_access ? DELETE : 0),
                   FILE_SHARE_READ, FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL,
                   &raw) < 0)
    return false;
  OwnedHandle marker(raw);
  FileFacts facts;
  if (!QueryFacts(marker.get(), &facts) ||
      (facts.attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) != 0 ||
      facts.links != 1 || !ReadTokenFrom(marker.get(), token))
    return false;
  if (held != nullptr) *held = std::move(marker);
  return true;
}

enum class DirectoryContents { kEmpty, kOnlyMarker, kOther, kFailure };

DirectoryContents ListContents(HANDLE directory, const std::wstring& marker_leaf) {
  std::vector<uint64_t> buffer(8192);
  FILE_INFO_BY_HANDLE_CLASS information = FileFullDirectoryRestartInfo;
  bool found_marker = false;
  for (;;) {
    if (!GetFileInformationByHandleEx(directory, information, buffer.data(),
                                      static_cast<DWORD>(buffer.size() * sizeof(uint64_t))))
      return GetLastError() == ERROR_NO_MORE_FILES
                 ? (found_marker ? DirectoryContents::kOnlyMarker : DirectoryContents::kEmpty)
                 : DirectoryContents::kFailure;
    information = FileFullDirectoryInfo;
    auto* entry = reinterpret_cast<FILE_FULL_DIR_INFO*>(buffer.data());
    for (;;) {
      const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
      if (name != L"." && name != L"..") {
        if (found_marker || marker_leaf.empty() ||
            CompareStringOrdinal(name.c_str(), static_cast<int>(name.size()), marker_leaf.c_str(),
                                 static_cast<int>(marker_leaf.size()), TRUE) != CSTR_EQUAL)
          return DirectoryContents::kOther;
        found_marker = true;
      }
      if (entry->NextEntryOffset == 0) break;
      entry = reinterpret_cast<FILE_FULL_DIR_INFO*>(reinterpret_cast<uint8_t*>(entry) +
                                                    entry->NextEntryOffset);
    }
  }
}

// The held directory carries `token` as its durable ownership proof and, when required, only the
// marker holding that token. `identity` receives the owned identity digest.
bool OwnedDirectoryMatches(const HeldDirectory& directory, const std::wstring& marker_leaf,
                           const std::string& token, bool require_only_marker,
                           std::string* identity) {
  std::string attribute_token, marker_token;
  if (!ReadOwnershipToken(directory.handle.get(), &attribute_token) || attribute_token != token)
    return false;
  if (require_only_marker &&
      (!HoldMarker(directory.handle.get(), marker_leaf, false, &marker_token, nullptr) ||
       marker_token != token ||
       ListContents(directory.handle.get(), marker_leaf) != DirectoryContents::kOnlyMarker))
    return false;
  return OwnedDirectoryIdentityDigest(directory.facts, token, identity);
}

napi_value DirectoryValue(napi_env env, const std::string* identity) {
  if (identity == nullptr) return AbsentEndpoint(env);
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "state", MakeString(env, "present"));
  napi_set_named_property(env, result, "identityDigest", MakeString(env, *identity));
  return result;
}

bool ReadDirectoryInput(napi_env env, napi_value input, std::vector<std::wstring>* segments) {
  return ReadSegments(env, input, "pathSegments", false, segments);
}

bool ReadDirectoryOwnershipInput(napi_env env, napi_value input,
                                 std::vector<std::wstring>* segments, std::wstring* marker_leaf,
                                 std::string* token) {
  std::string marker_utf8;
  return ReadDirectoryInput(env, input, segments) &&
         NamedString(env, input, "markerLeafName", &marker_utf8) &&
         NamedString(env, input, "ownershipToken", token) && IsLowerHex(*token, 64) &&
         marker_utf8 == ".sprint-coder-mkdir-" + token->substr(0, 32) &&
         Utf8ToWide(marker_utf8, marker_leaf);
}

bool ReadExpectedIdentity(napi_env env, napi_value input, std::string* identity) {
  return NamedString(env, input, "expectedIdentityDigest", identity) && IsLowerHex(*identity, 64);
}

#if defined(SPRINT_CODER_NATIVE_SAFE_FS_TESTING)
// Test builds only: stands in for another process that creates and closes a child in a directory
// between the removal's emptiness check and its quarantine rename.
void TestRaceChildBeforeQuarantine(HANDLE directory) {
  wchar_t name[128]{};
  const DWORD length =
      GetEnvironmentVariableW(L"SPRINT_CODER_NATIVE_SAFE_FS_RACE_QUARANTINE_CHILD", name, 128);
  if (length == 0 || length >= 128) return;
  HANDLE raw = INVALID_HANDLE_VALUE;
  if (OpenRelative(directory, std::wstring(name, length), FILE_WRITE_DATA | SYNCHRONIZE,
                   kObserveShare, FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL,
                   &raw) < 0)
    return;
  DWORD written = 0;
  WriteFile(raw, "raced", 5, &written, nullptr);
  CloseHandle(raw);
}
#endif

// Removes a directory this call created and still holds, together with its marker. Anything else
// it finds inside keeps the directory where it is.
void DiscardStagingDirectory(HANDLE directory, const std::wstring& marker_leaf,
                             const std::string& token) {
  std::string marker_token;
  OwnedHandle marker;
  DWORD error = 0;
  if (HoldMarker(directory, marker_leaf, true, &marker_token, &marker) && marker_token == token &&
      UnapprovedDataReason(marker.get()) == nullptr)
    DeleteHeld(marker.get(), &error);
  marker.reset();
  if (ListContents(directory, marker_leaf) == DirectoryContents::kEmpty &&
      !DirectoryCarriesData(directory))
    DeleteHeld(directory, &error);
}

}  // namespace

bool WindowsNativeFileIdentityDigest(uint64_t dev, uint64_t ino, uint32_t attributes,
                                     uint32_t links, std::string* output) {
  return Sha256String("[\"native-file-identity-v1\",\"" + std::to_string(dev) + "\",\"" +
                          std::to_string(ino) + "\"," +
                          std::to_string(NodeCompatibleMode(attributes, kRegularFileType)) + "," +
                          std::to_string(links) + ",\"file\"]",
                      output);
}

napi_value WindowsMutationProbeCapabilities(napi_env env) {
  napi_value capabilities;
  napi_create_object(env, &capabilities);
  napi_set_named_property(env, capabilities, "rootSession", MakeBoolean(env, true));
  napi_set_named_property(env, capabilities, "workspaceLock", MakeBoolean(env, true));
  napi_set_named_property(env, capabilities, "durableFence", MakeBoolean(env, true));
  napi_set_named_property(env, capabilities, "synchronousInvalidation", MakeBoolean(env, true));
  napi_set_named_property(env, capabilities, "mutation", MakeBoolean(env, true));
  napi_set_named_property(env, capabilities, "mutationScope", MakeString(env, "full"));
  napi_set_named_property(env, capabilities, "directoryOwnership",
                          MakeString(env, "workspace-probed"));
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
  OwnedHandle root(CreateFileW(workspace_wide.c_str(), kDirectoryReadAccess, kObserveShare, nullptr,
                               OPEN_EXISTING,
                               FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!root || IsReparsePoint(root.get()) || !IsDirectoryHandle(root.get()))
    return ThrowFailure(env, "ROOT_IDENTITY_CHANGED", "Workspace root is not a safe directory");
  uint64_t actual_dev = 0, actual_ino = 0;
  uint32_t links = 0;
  if (!FileIdentity(root.get(), &actual_dev, &actual_ino, &links) ||
      actual_dev != expected_dev || actual_ino != expected_ino)
    return ThrowFailure(env, "ROOT_IDENTITY_CHANGED", "Workspace root identity changed");
  OwnedHandle lock_directory(CreateFileW(lock_wide.c_str(), kDirectoryReadAccess, kObserveShare,
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
  uint64_t lock_dev = 0, lock_ino = 0;
  uint32_t lock_links = 0;
  if (!FileIdentity(lock.get(), &lock_dev, &lock_ino, &lock_links) || lock_links != 1)
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
  if (!session || !ValidateJournalBinding(env, argv[0])) return nullptr;
  std::vector<std::wstring> source, destination, auxiliary;
  bool destination_null = false, auxiliary_null = false;
  if (!ReadSegments(env, argv[0], "sourceSegments", false, &source))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs source path");
  if (!ReadNullableSegments(env, argv[0], "destinationSegments", &destination_null, &destination) ||
      !ReadNullableSegments(env, argv[0], "auxiliarySegments", &auxiliary_null, &auxiliary))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs endpoint path");
  IntentView view;
  Failure failure;
  if (!ObserveIntentView(session, source, destination_null ? nullptr : &destination,
                         auxiliary_null ? nullptr : &auxiliary, &view, &failure))
    return ThrowFailure(env, failure);
  return EffectValue(env, view.source, view.destination, view.auxiliary);
}

// Read-only, and called before the Edit Saga journals the intent: whether an update or delete of
// the sealed source could be undone exactly. A source that is absent, unsafe or no longer the
// sealed revision is allowed here, because the journaled effect path detects and reports it.
napi_value WindowsMutationPreflightIntentEffect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "preflightIntentEffect requires one input object");
  auto session = SessionFor(env, argv[0]);
  if (!session) return nullptr;
  std::string kind;
  std::vector<std::wstring> source;
  EndpointRevision expected;
  if (!NamedString(env, argv[0], "kind", &kind) ||
      !ReadSegments(env, argv[0], "sourceSegments", false, &source) ||
      !ReadExpectation(env, argv[0], "expectedSource", &expected))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs effect preflight");
  napi_value result;
  napi_create_object(env, &result);
  const char* reason = nullptr;
  PinnedDirectory parent;
  HANDLE raw = INVALID_HANDLE_VALUE;
  if ((kind == "update" || kind == "delete") && expected.present &&
      PinDirectoryPath(session->root.get(), ParentOf(source), false, &parent) &&
      OpenRelative(parent.get(), source.back(),
                   FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
                   kObserveShare, FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL,
                   &raw) >= 0) {
    const OwnedHandle file(raw);
    EndpointRevision observed;
    if (ObserveHandle(file.get(), &observed)) {
      ApplyObservedMode(*session, &observed);
      if (SameRevision(observed, expected))
        reason = IrreversibleEffectReason(kind == "delete", file.get(), file.get(), parent.get());
    }
  }
  napi_set_named_property(env, result, "allowed", MakeBoolean(env, reason == nullptr));
  if (reason != nullptr) napi_set_named_property(env, result, "reason", MakeString(env, reason));
  return result;
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
  std::vector<std::wstring> parents, source;
  std::string kind, leaf_utf8, expected_hash;
  uint32_t expected_size = 0, expected_mode = 0;
  EndpointRevision expected_source;
  if (napi_is_buffer(env, argv[1], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, argv[1], &bytes, &length) != napi_ok ||
      !NamedString(env, argv[0], "kind", &kind) || (kind != "add" && kind != "update") ||
      // An update stages beside the revision it replaces, which it must name and seal.
      (kind == "update" &&
       (!ReadSegments(env, argv[0], "sourceSegments", false, &source) ||
        !ReadExpectation(env, argv[0], "expectedSource", &expected_source) ||
        !expected_source.present)) ||
      !ReadSegments(env, argv[0], "parentSegments", true, &parents) ||
      (kind == "update" && ParentOf(source) != parents) ||
      !NamedString(env, argv[0], "leafName", &leaf_utf8) ||
      !NamedString(env, argv[0], "expectedContentHash", &expected_hash) ||
      !IsLowerHex(expected_hash, 64) ||
      !NamedUint32(env, argv[0], "expectedSize", &expected_size) ||
      !NamedUint32(env, argv[0], "expectedMode", &expected_mode) || length != expected_size ||
      length > kMaxArtifactBytes || (expected_mode & 0170000) != kRegularFileType)
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs staged artifact");
  std::string actual_hash;
  if (!Sha256Bytes(static_cast<const uint8_t*>(bytes), length, &actual_hash) ||
      actual_hash != expected_hash)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs staged artifact hash mismatched");
  std::wstring leaf;
  if (!Utf8ToWide(leaf_utf8, &leaf) || !IsSafeSegment(leaf) || !IsTemporaryLeaf(leaf))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs staged leaf");
  PinnedDirectory parent;
  if (!PinDirectoryPath(session->root.get(), parents, true, &parent))
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs staging parent is unsafe");
  // A new file inherits from its parent. An update's bytes are created under the access control of
  // the revision they replace, before any of them is written, or not at all.
  CarriedSecurity carried;
  PredictedSecurity prediction;
  OwnedHandle source_handle;
  DWORD carried_attributes = 0;
  if (kind == "update") {
    HANDLE source_raw = INVALID_HANDLE_VALUE;
    if (OpenRelative(parent.get(), source.back(),
                     FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
                     kObserveShare, FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL,
                     &source_raw) < 0)
      return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs update source is not observable");
    source_handle.reset(source_raw);
    EndpointRevision source_revision;
    if (!ObserveHandle(source_handle.get(), &source_revision))
      return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs update source is unsafe");
    ApplyObservedMode(*session, &source_revision);
    if (!SameRevision(source_revision, expected_source))
      return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs update source changed before staging");
    // The preflight's refusals again, before a single byte of the new revision exists: encrypted
    // or labelled content, for one, must never be written out as a plain staged copy.
    if (const char* reason = IrreversibleEffectReason(false, source_handle.get(),
                                                      source_handle.get(), parent.get(),
                                                      &prediction))
      return ThrowFailure(env, "EFFECT_REFUSED", reason);
    FileFacts source_facts;
    if (!QueryFacts(source_handle.get(), &source_facts))
      return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs update source is unsafe");
    carried_attributes = source_facts.attributes & kCarriedAttributes;
    if (!CaptureSourceSecurity(source_handle.get(), &carried))
      return ThrowFailure(env, "UNSAFE_PATH",
                          "NativeSafeFs cannot carry the update source access control");
  }
  if (!SessionCurrent(session))
    return ThrowFailure(env, "STALE_SESSION", "NativeSafeFs session was invalidated before staging");
  HANDLE raw = INVALID_HANDLE_VALUE;
  const NTSTATUS status = OpenRelative(
      parent.get(), leaf, FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES |
                              FILE_WRITE_ATTRIBUTES | DELETE | READ_CONTROL | WRITE_DAC |
                              (carried.owner != nullptr ? WRITE_OWNER : 0) | SYNCHRONIZE,
      FILE_SHARE_READ, FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &raw,
      carried.applies ? &carried.creation : nullptr);
  if (status == kStatusObjectNameCollision)
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs staging artifact already exists");
  if (status < 0)
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs staging artifact could not be created");
  OwnedHandle file(raw);
  // Discards the artifact this call created, unless something else wrote a stream or extended
  // attributes onto it meanwhile: that stays, like any data nobody approved.
  const auto discard = [&](const char* code, const char* message) {
    DWORD error = 0;
    if (UnapprovedDataReason(file.get()) == nullptr) DeleteHeld(file.get(), &error);
    return ThrowFailure(env, code, message);
  };
  // Re-applied through the handle like ReplaceFileWithBackup, so an unprotected DACL takes its
  // inherited entries from the shared parent exactly as the source did.
  if (carried.applies &&
      SetSecurityInfo(file.get(), SE_FILE_OBJECT, carried.information, carried.owner, nullptr,
                      carried.dacl, nullptr) != ERROR_SUCCESS)
    return discard("UNSAFE_PATH", "NativeSafeFs cannot carry the update source access control");
  // Nothing is written until the staged file demonstrably has the source's access control.
  if (source_handle && !MatchesPrediction(file.get(), prediction))
    return discard("EFFECT_REFUSED", kAccessControlUpdateRefusal);
  DWORD written = 0;
  if ((length > 0 &&
       (!WriteFile(file.get(), bytes, static_cast<DWORD>(length), &written, nullptr) ||
        written != length)) ||
      !FlushFileBuffers(file.get()))
    return discard("NATIVE_FAILURE", "NativeSafeFs staging artifact write failed");
  // A mode without write permission is the one Windows attribute a POSIX mode maps to; an update
  // also keeps the hidden, system and not-indexed attributes of the revision it replaces.
  const DWORD added_attributes =
      carried_attributes | ((expected_mode & 0222) == 0 ? FILE_ATTRIBUTE_READONLY : 0);
  if (added_attributes != 0) {
    FILE_BASIC_INFO basic{};
    if (!GetFileInformationByHandleEx(file.get(), FileBasicInfo, &basic, sizeof(basic)))
      return discard("NATIVE_FAILURE", "NativeSafeFs staging attributes could not be read");
    FILE_BASIC_INFO update{};
    update.FileAttributes =
        (basic.FileAttributes & ~static_cast<DWORD>(FILE_ATTRIBUTE_NORMAL)) | added_attributes;
    if (!SetFileInformationByHandle(file.get(), FileBasicInfo, &update, sizeof(update)))
      return discard("NATIVE_FAILURE", "NativeSafeFs staging attributes could not be set");
  }
  EndpointRevision revision;
  if (!ObserveHandle(file.get(), &revision) || revision.content_hash != expected_hash ||
      revision.size != expected_size)
    return discard("NATIVE_FAILURE", "NativeSafeFs staging verification failed");
  if (!FlushFileBuffers(parent.get()))
    return discard("NATIVE_FAILURE", "NativeSafeFs staging parent flush failed");
  revision.mode = expected_mode;
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
  EffectInput input;
  if (!ReadEffectInput(env, argv[0], &input))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs effect");
  if (!EffectShapeIsValid(input))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs effect shape");
  const std::vector<std::wstring>* destination =
      input.has_destination ? &input.destination : nullptr;
  const std::vector<std::wstring>* auxiliary = input.has_auxiliary ? &input.auxiliary : nullptr;
  IntentView before;
  Failure failure;
  if (!ObserveIntentView(session, input.source, destination, auxiliary, &before, &failure))
    return ThrowFailure(env, failure);
  if (!Matches(before.source, input.expected_source) ||
      !Matches(before.destination, input.expected_destination) ||
      !Matches(before.auxiliary, input.expected_auxiliary))
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs effect precondition changed");
  bool applied = false;
  if (input.kind == "update")
    applied = ApplyUpdate(session, input, before.phase, &failure);
  else if (before.phase != SwapPhase::kNone)
    applied = Fail(&failure, "UNSAFE_PATH", "NativeSafeFs effect precondition changed");
  else if (input.kind == "add")
    applied = ApplyMove(session, input.auxiliary, input.expected_auxiliary, input.source, false,
                        &failure);
  else if (input.kind == "delete")
    applied = ApplyMove(session, input.source, input.expected_source, input.auxiliary, true,
                        &failure);
  else
    applied = ApplyMove(session, input.source, input.expected_source, input.destination, false,
                        &failure);
  if (!applied) return ThrowFailure(env, failure);
  IntentView after;
  if (!ObserveIntentView(session, input.source, destination, auxiliary, &after, &failure))
    return ThrowFailure(env, failure);
  if (!EffectObservationIsValid(input, after))
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs effect topology is indeterminate");
  return EffectValue(env, after.source, after.destination, after.auxiliary);
}

napi_value WindowsMutationCleanupIntentAuxiliary(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "cleanupIntentAuxiliary requires one input object");
  auto session = SessionFor(env, argv[0]);
  if (!session || !BindJournal(env, argv[0], session.get())) return nullptr;
  std::vector<std::wstring> auxiliary;
  EndpointRevision expected;
  if (!ReadSegments(env, argv[0], "auxiliarySegments", false, &auxiliary) ||
      !ReadExpectation(env, argv[0], "expectedAuxiliary", &expected) ||
      (!IsTemporaryLeaf(auxiliary.back()) && !IsReservedLeaf(auxiliary.back(), kTombstonePrefix)))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs cleanup auxiliary");
  PinnedDirectory parent;
  if (!PinDirectoryPath(session->root.get(), ParentOf(auxiliary), true, &parent))
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs cleanup parent is unsafe");
  const bool temporary = IsTemporaryLeaf(auxiliary.back());
  const std::wstring swap_leaf = temporary ? SwapLeafFor(auxiliary.back()) : std::wstring();
  EndpointRevision auxiliary_revision, parked_revision;
  OwnedHandle auxiliary_handle, parked_handle;
  const EndpointResult auxiliary_result =
      HoldEndpoint(*session, parent.get(), auxiliary.back(), &auxiliary_revision, &auxiliary_handle);
  const EndpointResult parked_result =
      temporary ? HoldEndpoint(*session, parent.get(), swap_leaf, &parked_revision, &parked_handle)
                : EndpointResult::kAbsent;
  if (auxiliary_result == EndpointResult::kFailure || parked_result == EndpointResult::kFailure)
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs cleanup observation failed");
  if (auxiliary_result == EndpointResult::kUnsafe || parked_result == EndpointResult::kUnsafe ||
      (auxiliary_result == EndpointResult::kPresent && parked_result == EndpointResult::kPresent))
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs auxiliary cleanup observed drift");
  // An update interrupted after publishing leaves its previous revision under the swap name.
  const bool parked = parked_result == EndpointResult::kPresent;
  if (auxiliary_result == EndpointResult::kAbsent && !parked) return AbsentEndpoint(env);
  if (!SameRevision(parked ? parked_revision : auxiliary_revision, expected))
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs cleanup identity changed");
  if (!SessionCurrent(session))
    return ThrowFailure(env, "STALE_SESSION", "NativeSafeFs session was invalidated before cleanup");
  DWORD error = 0;
  OwnedHandle& target = parked ? parked_handle : auxiliary_handle;
  // An intent resumed after a restart runs no preflight, and the auxiliary may have gained a
  // stream or extended attributes since the effect; deleting it would destroy them.
  if (const char* reason = UnapprovedDataReason(target.get()))
    return ThrowFailure(env, "EFFECT_REFUSED", reason);
  if (!DeleteHeld(target.get(), &error))
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs auxiliary cleanup failed");
  target.reset();
  if (!FlushFileBuffers(parent.get()))
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs cleanup parent flush failed");
  if (ProbeName(parent.get(), auxiliary.back()) != EndpointResult::kAbsent ||
      (temporary && ProbeName(parent.get(), swap_leaf) != EndpointResult::kAbsent))
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs cleanup did not become absent");
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

napi_value WindowsMutationObserveDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs directory input");
  auto session = SessionFor(env, argv[0]);
  if (!session) return nullptr;
  std::vector<std::wstring> segments;
  if (!ReadDirectoryInput(env, argv[0], &segments))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs directory input");
  PinnedDirectory parent;
  if (!PinDirectoryPath(session->root.get(), ParentOf(segments), false, &parent))
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs directory parent is unsafe");
  HeldDirectory directory;
  const EndpointResult result =
      HoldDirectory(parent.get(), segments.back(), 0, kObserveShare, &directory);
  if (result == EndpointResult::kAbsent) return DirectoryValue(env, nullptr);
  if (result == EndpointResult::kUnsafe)
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs directory endpoint is not a directory");
  if (result == EndpointResult::kFailure)
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs directory observation failed");
  std::string token, identity;
  const bool owned = ReadOwnershipToken(directory.handle.get(), &token);
  if (!(owned ? OwnedDirectoryIdentityDigest(directory.facts, token, &identity)
              : DirectoryIdentityDigest(directory.facts, &identity)))
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs directory identity failed");
  return DirectoryValue(env, &identity);
}

napi_value WindowsMutationCreateDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "NativeSafeFs create directory input must be an object");
  auto session = SessionFor(env, argv[0]);
  if (!session) return nullptr;
  std::vector<std::wstring> segments;
  std::wstring marker_leaf;
  std::string token;
  if (!ReadDirectoryOwnershipInput(env, argv[0], &segments, &marker_leaf, &token))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs directory input");
  PinnedDirectory parent;
  if (!PinDirectoryPath(session->root.get(), ParentOf(segments), true, &parent))
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs directory parent is unsafe");
  if (ProbeName(parent.get(), segments.back()) != EndpointResult::kAbsent)
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs directory destination already exists");
  if (!SessionCurrent(session))
    return ThrowFailure(env, "STALE_SESSION", "NativeSafeFs session was invalidated before mkdir");
  const std::wstring staging_leaf = L".sprint-coder-mkdir-stage-" + AsciiToWide(token.substr(0, 32));
  constexpr ACCESS_MASK kStagingAccess = kDirectoryReadAccess | kDirectoryFlushAccess | DELETE;
  HeldDirectory staging;
  HANDLE raw = INVALID_HANDLE_VALUE;
  NTSTATUS status = OpenRelative(parent.get(), staging_leaf, kStagingAccess, kPinShare, FILE_CREATE,
                                 FILE_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &raw);
  const bool created = status >= 0;
  if (created) {
    staging.handle.reset(raw);
    if (!QueryFacts(raw, &staging.facts))
      return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs mkdir staging identity failed");
  } else if (status != kStatusObjectNameCollision) {
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs mkdir staging directory failed");
  } else if (HoldDirectory(parent.get(), staging_leaf, kDirectoryFlushAccess | DELETE, kPinShare,
                           &staging) != EndpointResult::kPresent) {
    // A previous authorized attempt may have left its staging directory; anything else is refused.
    return ThrowFailure(env, "UNSAFE_PATH", "NativeSafeFs mkdir staging endpoint is unsafe");
  }
  Failure failure;
  if (created) {
    status = WriteOwnershipToken(staging.handle.get(), token);
    HANDLE marker_raw = INVALID_HANDLE_VALUE;
    if (status == kStatusInvalidParameter || status == kStatusObjectNameInvalid ||
        status == kStatusNotSupported)
      Fail(&failure, "UNSUPPORTED_PLATFORM",
           "Workspace filesystem does not support durable directory ownership");
    else if (status < 0 ||
             OpenRelative(staging.handle.get(), marker_leaf,
                          FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, 0, FILE_CREATE,
                          FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL, &marker_raw) < 0)
      Fail(&failure, "NATIVE_FAILURE", "NativeSafeFs mkdir ownership marker failed");
    else {
      OwnedHandle marker(marker_raw);
      if (!WriteTokenTo(marker.get(), token) || !FlushFileBuffers(staging.handle.get()))
        Fail(&failure, "NATIVE_FAILURE", "NativeSafeFs mkdir ownership marker failed");
    }
  }
  std::string identity;
  if (failure.code.empty() && !OwnedDirectoryMatches(staging, marker_leaf, token, true, &identity))
    Fail(&failure, "UNSAFE_PATH", "NativeSafeFs mkdir staging ownership changed");
  if (failure.code.empty() && !SessionCurrent(session))
    Fail(&failure, "STALE_SESSION", "NativeSafeFs session was invalidated before mkdir");
  bool published = false;
  if (failure.code.empty()) {
    status = MoveHandleNoReplace(staging.handle.get(), parent.get(), segments.back());
    if (status < 0)
      MoveFailure(status, &failure);
    else
      published = true;
  }
  if (failure.code.empty()) {
    HeldDirectory visible;
    if (HoldDirectory(parent.get(), segments.back(), 0, kObserveShare, &visible) !=
            EndpointResult::kPresent ||
        !SameObject(visible.facts, staging.facts))
      Fail(&failure, "UNSAFE_PATH", "NativeSafeFs published directory identity changed");
  }
  if (failure.code.empty() && !FlushFileBuffers(parent.get()))
    Fail(&failure, "NATIVE_FAILURE", "NativeSafeFs mkdir parent flush failed");
  if (!failure.code.empty() && published &&
      MoveHandleNoReplace(staging.handle.get(), parent.get(), staging_leaf) >= 0)
    published = false;
  if (!failure.code.empty() && created && !published) {
    DiscardStagingDirectory(staging.handle.get(), marker_leaf, token);
    FlushFileBuffers(parent.get());
  }
  if (!failure.code.empty()) return ThrowFailure(env, failure);
  return DirectoryValue(env, &identity);
}

napi_value WindowsMutationInspectDirectoryOwnership(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "Invalid directory ownership input");
  auto session = SessionFor(env, argv[0]);
  if (!session) return nullptr;
  std::vector<std::wstring> segments;
  std::wstring marker_leaf;
  std::string token;
  if (!ReadDirectoryOwnershipInput(env, argv[0], &segments, &marker_leaf, &token))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid directory ownership input");
  PinnedDirectory parent;
  if (!PinDirectoryPath(session->root.get(), ParentOf(segments), false, &parent))
    return ThrowFailure(env, "UNSAFE_PATH", "Directory parent changed");
  HeldDirectory directory;
  const EndpointResult result =
      HoldDirectory(parent.get(), segments.back(), 0, kPinShare, &directory);
  if (result == EndpointResult::kAbsent) return DirectoryValue(env, nullptr);
  std::string identity;
  if (result != EndpointResult::kPresent)
    return ThrowFailure(env, "UNSAFE_PATH", "Directory ownership endpoint is unsafe");
  if (!OwnedDirectoryMatches(directory, marker_leaf, token, true, &identity))
    return ThrowFailure(env, "UNSAFE_PATH", "Directory ownership marker does not match");
  return DirectoryValue(env, &identity);
}

napi_value WindowsMutationCleanupDirectoryOwnership(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "Invalid directory ownership cleanup input");
  auto session = SessionFor(env, argv[0]);
  if (!session) return nullptr;
  std::vector<std::wstring> segments;
  std::wstring marker_leaf;
  std::string token, expected_identity;
  if (!ReadDirectoryOwnershipInput(env, argv[0], &segments, &marker_leaf, &token) ||
      !ReadExpectedIdentity(env, argv[0], &expected_identity))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid directory ownership cleanup input");
  PinnedDirectory parent;
  if (!PinDirectoryPath(session->root.get(), ParentOf(segments), false, &parent))
    return ThrowFailure(env, "UNSAFE_PATH", "Directory identity changed");
  HeldDirectory directory;
  std::string identity;
  if (HoldDirectory(parent.get(), segments.back(), kDirectoryFlushAccess, kPinShare, &directory) !=
          EndpointResult::kPresent ||
      !OwnedDirectoryMatches(directory, marker_leaf, token, false, &identity) ||
      identity != expected_identity)
    return ThrowFailure(env, "UNSAFE_PATH", "Directory marker cleanup refused non-owned contents");
  std::string marker_token;
  OwnedHandle marker;
  if (!HoldMarker(directory.handle.get(), marker_leaf, true, &marker_token, &marker)) {
    // Already removed by an earlier attempt: the owned directory must still be empty.
    if (ListContents(directory.handle.get(), marker_leaf) != DirectoryContents::kEmpty)
      return ThrowFailure(env, "UNSAFE_PATH", "Directory marker cleanup refused non-owned contents");
    return MakeUndefined(env);
  }
  if (marker_token != token ||
      ListContents(directory.handle.get(), marker_leaf) != DirectoryContents::kOnlyMarker)
    return ThrowFailure(env, "UNSAFE_PATH", "Directory marker cleanup refused non-owned contents");
  if (!SessionCurrent(session))
    return ThrowFailure(env, "STALE_SESSION",
                        "NativeSafeFs session was invalidated before marker cleanup");
  if (const char* reason = UnapprovedDataReason(marker.get()))
    return ThrowFailure(env, "EFFECT_REFUSED", reason);
  DWORD error = 0;
  if (!DeleteHeld(marker.get(), &error))
    return ThrowFailure(env, "NATIVE_FAILURE", "cleanup mkdir ownership marker failed");
  marker.reset();
  if (!FlushFileBuffers(directory.handle.get()))
    return ThrowFailure(env, "NATIVE_FAILURE", "cleanup mkdir ownership marker flush failed");
  return MakeUndefined(env);
}

napi_value WindowsMutationRemoveDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs remove directory input");
  auto session = SessionFor(env, argv[0]);
  if (!session) return nullptr;
  std::vector<std::wstring> segments;
  std::string expected_identity;
  if (!ReadDirectoryInput(env, argv[0], &segments) ||
      !ReadExpectedIdentity(env, argv[0], &expected_identity))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid NativeSafeFs remove directory input");
  PinnedDirectory parent;
  if (!PinDirectoryPath(session->root.get(), ParentOf(segments), true, &parent))
    return ThrowFailure(env, "UNSAFE_PATH", "Directory parent changed");
  const std::wstring quarantine_leaf =
      L".sprint-coder-rmdir-" + AsciiToWide(expected_identity.substr(0, 32));
  const auto owned = [&](const HeldDirectory& directory) {
    std::string token, identity;
    return ReadOwnershipToken(directory.handle.get(), &token) &&
           OwnedDirectoryIdentityDigest(directory.facts, token, &identity) &&
           identity == expected_identity;
  };
  const auto empty = [](const HeldDirectory& directory) {
    return ListContents(directory.handle.get(), std::wstring()) == DirectoryContents::kEmpty;
  };
  // Holds the owned directory itself from here on: first under its name, then in quarantine.
  HeldDirectory target;
  const EndpointResult result =
      HoldDirectory(parent.get(), segments.back(), DELETE, kPinShare, &target);
  if (result == EndpointResult::kPresent) {
    if (!owned(target) || !empty(target))
      return ThrowFailure(env, "UNSAFE_PATH",
                          "NativeSafeFs directory ownership changed before removal");
    // Streams or extended attributes written onto the directory itself are not entries, and
    // removing the directory would destroy them.
    if (DirectoryCarriesData(target.handle.get()))
      return ThrowFailure(env, "EFFECT_REFUSED", kDirectoryDataRefusal);
    if (!SessionCurrent(session))
      return ThrowFailure(env, "STALE_SESSION",
                          "NativeSafeFs session was invalidated before directory removal");
#if defined(SPRINT_CODER_NATIVE_SAFE_FS_TESTING)
    TestRaceChildBeforeQuarantine(target.handle.get());
#endif
    const NTSTATUS status = MoveHandleNoReplace(target.handle.get(), parent.get(), quarantine_leaf);
    Failure failure;
    if (status < 0) {
      MoveFailure(status, &failure);
      return ThrowFailure(env, failure);
    }
  } else if (result == EndpointResult::kAbsent) {
    // A previous authorized attempt may already have quarantined the directory.
    const EndpointResult quarantine =
        HoldDirectory(parent.get(), quarantine_leaf, DELETE, kPinShare, &target);
    if (quarantine == EndpointResult::kAbsent)
      return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs directory quarantine is missing");
    if (quarantine != EndpointResult::kPresent || !owned(target))
      return ThrowFailure(env, "UNSAFE_PATH", "Directory identity changed during quarantine");
  } else {
    return ThrowFailure(env, "UNSAFE_PATH",
                        "NativeSafeFs directory identity changed before removal");
  }
  // Holding the handle does not stop another process from creating a child between the emptiness
  // check and the rename. Whatever arrived goes back, inside the same directory object, to the name
  // it was created under; a name taken in the meantime keeps it in quarantine, never deleted.
  const bool gained_children = !empty(target);
  if (gained_children || DirectoryCarriesData(target.handle.get())) {
    const NTSTATUS restored = MoveHandleNoReplace(target.handle.get(), parent.get(), segments.back());
    FlushFileBuffers(parent.get());
    if (!gained_children && restored >= 0)
      return ThrowFailure(env, "EFFECT_REFUSED", kDirectoryDataRefusal);
    return ThrowFailure(env, "UNSAFE_PATH",
                        restored >= 0 ? "NativeSafeFs directory gained contents during quarantine "
                                        "and was restored to its name"
                                      : "NativeSafeFs directory gained contents during quarantine "
                                        "and stays quarantined because its name is taken");
  }
  if (!FlushFileBuffers(parent.get()))
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs removed directory parent flush failed");
  return MakeUndefined(env);
}

napi_value WindowsMutationCleanupDirectoryRemoval(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1)
    return ThrowFailure(env, "INVALID_INPUT", "Invalid directory removal cleanup input");
  auto session = SessionFor(env, argv[0]);
  if (!session) return nullptr;
  std::vector<std::wstring> segments;
  std::string expected_identity;
  if (!ReadDirectoryInput(env, argv[0], &segments) ||
      !ReadExpectedIdentity(env, argv[0], &expected_identity))
    return ThrowFailure(env, "INVALID_INPUT", "Invalid directory removal cleanup input");
  PinnedDirectory parent;
  if (!PinDirectoryPath(session->root.get(), ParentOf(segments), true, &parent))
    return ThrowFailure(env, "UNSAFE_PATH", "Directory parent changed");
  if (ProbeName(parent.get(), segments.back()) != EndpointResult::kAbsent)
    return ThrowFailure(env, "UNSAFE_PATH", "Directory removal cleanup found a target");
  const std::wstring quarantine_leaf =
      L".sprint-coder-rmdir-" + AsciiToWide(expected_identity.substr(0, 32));
  HeldDirectory quarantined;
  const EndpointResult result =
      HoldDirectory(parent.get(), quarantine_leaf, DELETE, kPinShare, &quarantined);
  // cleanup_pending is the durable proof that removal was authorized and completed.
  if (result == EndpointResult::kAbsent) return MakeUndefined(env);
  std::string token, identity;
  if (result != EndpointResult::kPresent ||
      !ReadOwnershipToken(quarantined.handle.get(), &token) ||
      !OwnedDirectoryIdentityDigest(quarantined.facts, token, &identity) ||
      identity != expected_identity ||
      ListContents(quarantined.handle.get(), std::wstring()) != DirectoryContents::kEmpty)
    return ThrowFailure(env, "UNSAFE_PATH", "Directory removal cleanup refused quarantine");
  if (DirectoryCarriesData(quarantined.handle.get()))
    return ThrowFailure(env, "EFFECT_REFUSED", kDirectoryDataRefusal);
  if (!SessionCurrent(session))
    return ThrowFailure(env, "STALE_SESSION",
                        "NativeSafeFs session was invalidated before removal cleanup");
  DWORD error = 0;
  if (!DeleteHeld(quarantined.handle.get(), &error))
    return ThrowFailure(env, error == ERROR_DIR_NOT_EMPTY ? "UNSAFE_PATH" : "NATIVE_FAILURE",
                        "cleanup removed directory quarantine failed");
  quarantined.handle.reset();
  if (!FlushFileBuffers(parent.get()) ||
      ProbeName(parent.get(), quarantine_leaf) != EndpointResult::kAbsent)
    return ThrowFailure(env, "NATIVE_FAILURE", "cleanup removed directory quarantine failed");
  return MakeUndefined(env);
}
