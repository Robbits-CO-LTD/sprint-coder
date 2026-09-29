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
// `parent` itself with the requested access and sharing.
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
               const std::vector<std::wstring>& to, Failure* failure) {
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

// Removes a directory this call created and still holds, together with its marker. Anything else
// it finds inside keeps the directory where it is.
void DiscardStagingDirectory(HANDLE directory, const std::wstring& marker_leaf,
                             const std::string& token) {
  std::string marker_token;
  OwnedHandle marker;
  DWORD error = 0;
  if (HoldMarker(directory, marker_leaf, true, &marker_token, &marker) && marker_token == token)
    DeleteHeld(marker.get(), &error);
  marker.reset();
  if (ListContents(directory, marker_leaf) == DirectoryContents::kEmpty)
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
      !ReadSegments(env, argv[0], "parentSegments", true, &parents) ||
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
  if (!SessionCurrent(session))
    return ThrowFailure(env, "STALE_SESSION", "NativeSafeFs session was invalidated before staging");
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
  const auto discard = [&](const char* code, const char* message) {
    DWORD error = 0;
    DeleteHeld(file.get(), &error);
    return ThrowFailure(env, code, message);
  };
  DWORD written = 0;
  if ((length > 0 &&
       (!WriteFile(file.get(), bytes, static_cast<DWORD>(length), &written, nullptr) ||
        written != length)) ||
      !FlushFileBuffers(file.get()))
    return discard("NATIVE_FAILURE", "NativeSafeFs staging artifact write failed");
  // A mode without write permission is the one Windows attribute a POSIX mode maps to.
  if ((expected_mode & 0222) == 0) {
    FILE_BASIC_INFO basic{};
    if (!GetFileInformationByHandleEx(file.get(), FileBasicInfo, &basic, sizeof(basic)))
      return discard("NATIVE_FAILURE", "NativeSafeFs staging attributes could not be read");
    FILE_BASIC_INFO update{};
    update.FileAttributes =
        (basic.FileAttributes & ~static_cast<DWORD>(FILE_ATTRIBUTE_NORMAL)) | FILE_ATTRIBUTE_READONLY;
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
    applied = ApplyMove(session, input.auxiliary, input.expected_auxiliary, input.source, &failure);
  else if (input.kind == "delete")
    applied = ApplyMove(session, input.source, input.expected_source, input.auxiliary, &failure);
  else
    applied = ApplyMove(session, input.source, input.expected_source, input.destination, &failure);
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
  const auto owned_empty = [&](const HeldDirectory& directory) {
    std::string token, identity;
    return ReadOwnershipToken(directory.handle.get(), &token) &&
           OwnedDirectoryIdentityDigest(directory.facts, token, &identity) &&
           identity == expected_identity &&
           ListContents(directory.handle.get(), std::wstring()) == DirectoryContents::kEmpty;
  };
  HeldDirectory target;
  const EndpointResult result =
      HoldDirectory(parent.get(), segments.back(), DELETE, kPinShare, &target);
  if (result == EndpointResult::kPresent) {
    if (!owned_empty(target))
      return ThrowFailure(env, "UNSAFE_PATH",
                          "NativeSafeFs directory ownership changed before removal");
    if (!SessionCurrent(session))
      return ThrowFailure(env, "STALE_SESSION",
                          "NativeSafeFs session was invalidated before directory removal");
    const NTSTATUS status = MoveHandleNoReplace(target.handle.get(), parent.get(), quarantine_leaf);
    Failure failure;
    if (status < 0) {
      MoveFailure(status, &failure);
      return ThrowFailure(env, failure);
    }
  } else if (result != EndpointResult::kAbsent) {
    return ThrowFailure(env, "UNSAFE_PATH",
                        "NativeSafeFs directory identity changed before removal");
  }
  // Absent: a previous authorized attempt may already have quarantined the directory.
  target.handle.reset();
  HeldDirectory quarantined;
  const EndpointResult quarantine =
      HoldDirectory(parent.get(), quarantine_leaf, 0, kPinShare, &quarantined);
  if (quarantine == EndpointResult::kAbsent)
    return ThrowFailure(env, "NATIVE_FAILURE", "NativeSafeFs directory quarantine is missing");
  if (quarantine != EndpointResult::kPresent || !owned_empty(quarantined))
    return ThrowFailure(env, "UNSAFE_PATH", "Directory identity changed during quarantine");
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
