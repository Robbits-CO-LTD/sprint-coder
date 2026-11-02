bool ReadProcessPath(HANDLE process, std::wstring *output) {
  if (process == nullptr || output == nullptr)
    return false;
  std::vector<wchar_t> buffer(32768, L'\0');
  DWORD length = static_cast<DWORD>(buffer.size());
  const bool read =
      QueryFullProcessImageNameW(process, 0, buffer.data(), &length) == TRUE;
  if (!read || length == 0 || length >= buffer.size())
    return false;
  *output = std::wstring(buffer.data(), length);
  return true;
}

bool ReadProcessPath(std::uint32_t pid, std::wstring *output) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr)
    return false;
  const bool read = ReadProcessPath(process, output);
  CloseHandle(process);
  return read;
}

struct WindowsFileIdentity {
  std::uint64_t volume_serial = 0;
  FILE_ID_128 file_id{};
};

struct WindowsExecutableIdentity {
  std::wstring path;
  std::string path_utf8;
  std::string executable_digest;
  std::string signer_digest;
  std::string identity_digest;
  std::string display_name;
  std::string policy_language = "unknown";
  bool microsoft_signer = false;
  WindowsFileIdentity file_identity;
};

struct LockedWindowsExecutable {
  HANDLE file = INVALID_HANDLE_VALUE;
  WindowsExecutableIdentity identity;

  LockedWindowsExecutable() = default;
  LockedWindowsExecutable(const LockedWindowsExecutable &) = delete;
  LockedWindowsExecutable &operator=(const LockedWindowsExecutable &) = delete;
  LockedWindowsExecutable(LockedWindowsExecutable &&other) noexcept
      : file(other.file), identity(std::move(other.identity)) {
    other.file = INVALID_HANDLE_VALUE;
  }
  LockedWindowsExecutable &operator=(LockedWindowsExecutable &&other) noexcept {
    if (this == &other)
      return *this;
    if (file != INVALID_HANDLE_VALUE)
      CloseHandle(file);
    file = other.file;
    identity = std::move(other.identity);
    other.file = INVALID_HANDLE_VALUE;
    return *this;
  }
  ~LockedWindowsExecutable() {
    if (file != INVALID_HANDLE_VALUE)
      CloseHandle(file);
  }
};

void CloseLockedWindowsExecutable(LockedWindowsExecutable *locked) {
  if (locked != nullptr && locked->file != INVALID_HANDLE_VALUE) {
    CloseHandle(locked->file);
    locked->file = INVALID_HANDLE_VALUE;
  }
}

bool SameWindowsFileIdentity(const WindowsFileIdentity &left,
                             const WindowsFileIdentity &right) {
  return left.volume_serial == right.volume_serial &&
         std::memcmp(left.file_id.Identifier, right.file_id.Identifier,
                     sizeof(left.file_id.Identifier)) == 0;
}

bool ReadWindowsFileIdentity(HANDLE file, WindowsFileIdentity *identity) {
  FILE_ID_INFO information{};
  if (file == INVALID_HANDLE_VALUE || identity == nullptr ||
      !GetFileInformationByHandleEx(file, FileIdInfo, &information,
                                    sizeof(information)))
    return false;
  identity->volume_serial = information.VolumeSerialNumber;
  identity->file_id = information.FileId;
  return true;
}

bool CanonicalWindowsPathFromHandle(HANDLE file, std::wstring *output) {
  if (file == INVALID_HANDLE_VALUE || output == nullptr)
    return false;
  constexpr DWORD flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
  const DWORD required = GetFinalPathNameByHandleW(file, nullptr, 0, flags);
  if (required == 0 || required > 32'767)
    return false;
  std::wstring path(static_cast<std::size_t>(required) + 1, L'\0');
  const DWORD length = GetFinalPathNameByHandleW(
      file, path.data(), static_cast<DWORD>(path.size()), flags);
  if (length == 0 || length >= path.size())
    return false;
  path.resize(length);
  static constexpr std::wstring_view unc_prefix = L"\\\\?\\UNC\\";
  static constexpr std::wstring_view local_prefix = L"\\\\?\\";
  if (path.starts_with(unc_prefix))
    path = L"\\\\" + path.substr(unc_prefix.size());
  else if (path.starts_with(local_prefix))
    path.erase(0, local_prefix.size());
  if (path.empty() || path.size() > 32'767)
    return false;
  *output = std::move(path);
  return true;
}

bool ReadFileDigest(HANDLE file, std::string *digest) {
  if (file == INVALID_HANDLE_VALUE || digest == nullptr)
    return false;
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag,
                                    sizeof(tag)) ||
      (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY |
                             FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    return false;
  }
  LARGE_INTEGER beginning{};
  if (!SetFilePointerEx(file, beginning, nullptr, FILE_BEGIN))
    return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_bytes = 0;
  DWORD result_bytes = 0;
  DWORD digest_bytes = 0;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr,
                                  0) != 0 ||
      BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                        reinterpret_cast<PUCHAR>(&object_bytes),
                        sizeof(object_bytes), &result_bytes, 0) != 0 ||
      BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                        reinterpret_cast<PUCHAR>(&digest_bytes),
                        sizeof(digest_bytes), &result_bytes, 0) != 0 ||
      digest_bytes != 32) {
    if (algorithm != nullptr)
      BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }
  std::vector<std::uint8_t> object(object_bytes);
  std::vector<std::uint8_t> digest_bytes_buffer(digest_bytes);
  if (BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, nullptr,
                       0, 0) != 0) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }
  // On the heap (S5-c-3 PR-5): a 1 MiB array here took the whole default 1 MiB stack, so a caller one
  // level deeper than V1's (the v2 judgement inside a start, or list_targets) overflowed it
  // (0xC00000FD, found by the v2 targets live seam). The bytes hashed and the digest are the same.
  std::vector<std::uint8_t> chunk(1 << 20);
  bool succeeded = true;
  for (;;) {
    DWORD read = 0;
    if (!ReadFile(file, chunk.data(), static_cast<DWORD>(chunk.size()), &read,
                  nullptr)) {
      succeeded = false;
      break;
    }
    if (read == 0)
      break;
    if (BCryptHashData(hash, chunk.data(), read, 0) != 0) {
      succeeded = false;
      break;
    }
  }
  if (succeeded)
    succeeded = BCryptFinishHash(hash, digest_bytes_buffer.data(), digest_bytes,
                                 0) == 0;
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!succeeded)
    return false;
  static constexpr char hexadecimal[] = "0123456789abcdef";
  digest->assign(digest_bytes_buffer.size() * 2, '0');
  for (std::size_t index = 0; index < digest_bytes_buffer.size(); ++index) {
    (*digest)[index * 2] = hexadecimal[digest_bytes_buffer[index] >> 4];
    (*digest)[index * 2 + 1] = hexadecimal[digest_bytes_buffer[index] & 0xf];
  }
  return true;
}

std::string HexBytes(std::span<const std::uint8_t> bytes) {
  static constexpr char hexadecimal[] = "0123456789abcdef";
  std::string result(bytes.size() * 2, '0');
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    result[index * 2] = hexadecimal[bytes[index] >> 4];
    result[index * 2 + 1] = hexadecimal[bytes[index] & 0xf];
  }
  return result;
}

bool ReadCertificateOrganization(PCCERT_CONTEXT certificate,
                                 std::wstring *organization) {
  if (certificate == nullptr || organization == nullptr)
    return false;
  void *organization_oid = const_cast<char *>(szOID_ORGANIZATION_NAME);
  const DWORD characters = CertGetNameStringW(
      certificate, CERT_NAME_ATTR_TYPE, 0, organization_oid, nullptr, 0);
  if (characters <= 1 || characters > 256)
    return false;
  std::wstring value(static_cast<std::size_t>(characters), L'\0');
  if (CertGetNameStringW(certificate, CERT_NAME_ATTR_TYPE, 0,
                         organization_oid, value.data(), characters) !=
      characters)
    return false;
  value.resize(characters - 1);
  *organization = std::move(value);
  return true;
}

bool ReadAuthenticodeSignerDigest(HANDLE file, const std::wstring &path,
                                  std::string *signer_digest,
                                  bool *microsoft_signer = nullptr) {
  if (microsoft_signer != nullptr)
    *microsoft_signer = false;
  WINTRUST_FILE_INFO file_info{};
  file_info.cbStruct = sizeof(file_info);
  file_info.pcwszFilePath = path.c_str();
  file_info.hFile = file;
  WINTRUST_DATA trust{};
  trust.cbStruct = sizeof(trust);
  trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_NONE;
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &file_info;
  trust.dwStateAction = WTD_STATEACTION_VERIFY;
  trust.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_SAFER_FLAG;
  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
#if defined(SPRINT_CODER_COMPUTER_USE_TEST_HANG)
  WindowsTestHang(WindowsTestHangPoint::WinVerifyTrust);
#endif
  const LONG verified = WinVerifyTrust(nullptr, &policy, &trust);
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &policy, &trust);
  if (verified != ERROR_SUCCESS)
    return false;

  HCERTSTORE store = nullptr;
  HCRYPTMSG message = nullptr;
  DWORD encoding = 0;
  DWORD content = 0;
  DWORD format = 0;
  if (!CryptQueryObject(CERT_QUERY_OBJECT_FILE, path.c_str(),
                        CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
                        CERT_QUERY_FORMAT_FLAG_BINARY, 0, &encoding, &content,
                        &format, &store, &message, nullptr))
    return false;
  DWORD signer_bytes = 0;
  bool success = CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0, nullptr,
                                  &signer_bytes) == TRUE &&
                 signer_bytes >= sizeof(CMSG_SIGNER_INFO);
  std::vector<std::uint8_t> signer_buffer(signer_bytes);
  if (success)
    success = CryptMsgGetParam(message, CMSG_SIGNER_INFO_PARAM, 0,
                               signer_buffer.data(), &signer_bytes) == TRUE;
  PCCERT_CONTEXT certificate = nullptr;
  if (success) {
    const auto *signer =
        reinterpret_cast<const CMSG_SIGNER_INFO *>(signer_buffer.data());
    CERT_INFO certificate_info{};
    certificate_info.Issuer = signer->Issuer;
    certificate_info.SerialNumber = signer->SerialNumber;
    certificate = CertFindCertificateInStore(
        store, encoding, 0, CERT_FIND_SUBJECT_CERT, &certificate_info, nullptr);
    success = certificate != nullptr;
  }
  std::array<std::uint8_t, 32> thumbprint{};
  DWORD thumbprint_bytes = static_cast<DWORD>(thumbprint.size());
  if (success)
    success = CertGetCertificateContextProperty(
                  certificate, CERT_SHA256_HASH_PROP_ID, thumbprint.data(),
                  &thumbprint_bytes) == TRUE &&
              thumbprint_bytes == thumbprint.size();
  if (success && microsoft_signer != nullptr) {
    std::wstring organization;
    *microsoft_signer =
        ReadCertificateOrganization(certificate, &organization) &&
        _wcsicmp(organization.c_str(), L"Microsoft Corporation") == 0;
  }
  if (certificate != nullptr)
    CertFreeCertificateContext(certificate);
  if (message != nullptr)
    CryptMsgClose(message);
  if (store != nullptr)
    CertCloseStore(store, 0);
  if (!success)
    return false;
  *signer_digest = HexBytes(thumbprint);
  return true;
}

std::string CurrentHelperSignerDigest() {
  static const auto *digest = new std::string([]() {
    std::vector<wchar_t> path(32'768, L'\0');
    const DWORD length = GetModuleFileNameW(
        nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (length == 0 || static_cast<std::size_t>(length) >= path.size())
      return std::string{};
    const std::wstring image_path(path.data(), length);
    HANDLE file = CreateFileW(image_path.c_str(), GENERIC_READ, FILE_SHARE_READ,
                              nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN,
                              nullptr);
    if (file == INVALID_HANDLE_VALUE)
      return std::string{};
    std::string signer;
    const bool verified =
        ReadAuthenticodeSignerDigest(file, image_path, &signer);
    CloseHandle(file);
    return verified ? signer : std::string{};
  }());
  return *digest;
}

std::string PolicyLanguageForWindowsExecutable(const std::wstring &path) {
  if (path.empty())
    return "unknown";
  std::array<wchar_t, LOCALE_NAME_MAX_LENGTH> language{};
  std::vector<wchar_t> mui_path(32'768, L'\0');
  ULONG language_characters = static_cast<ULONG>(language.size());
  ULONG mui_path_characters = static_cast<ULONG>(mui_path.size());
  ULONGLONG enumerator = 0;
  if (!GetFileMUIPath(MUI_LANGUAGE_NAME | MUI_USER_PREFERRED_UI_LANGUAGES,
                      path.c_str(), language.data(), &language_characters,
                      mui_path.data(), &mui_path_characters, &enumerator))
    return "unknown";
  const std::size_t length = wcsnlen_s(language.data(), language.size());
  if (length == 2 && _wcsnicmp(language.data(), L"en", 2) == 0)
    return "en";
  if (length == 2 && _wcsnicmp(language.data(), L"ja", 2) == 0)
    return "ja";
  if (length > 2 && (language[2] == L'-' || language[2] == L'_')) {
    if (_wcsnicmp(language.data(), L"en", 2) == 0)
      return "en";
    if (_wcsnicmp(language.data(), L"ja", 2) == 0)
      return "ja";
  }
  return "unknown";
}

std::string WindowsV2LabelTrimmed(std::string_view text);

// Main rejects labels whose JavaScript trim is empty. Preserve all nonblank V1 bytes, including
// surrounding whitespace, and share the V2 whitespace set only to detect the fallback (#947).
std::string WindowsV1DisplayName(std::string_view display_name) {
  return WindowsV2LabelTrimmed(display_name).empty() ? "Application" : std::string(display_name);
}

bool BuildLockedWindowsExecutableIdentity(HANDLE file,
                                          WindowsExecutableIdentity *output) {
  if (file == INVALID_HANDLE_VALUE || output == nullptr)
    return false;
  std::wstring path;
  WindowsFileIdentity file_identity;
  std::string executable_digest;
  if (!CanonicalWindowsPathFromHandle(file, &path) ||
      !ReadWindowsFileIdentity(file, &file_identity) ||
      !ReadFileDigest(file, &executable_digest))
    return false;
  std::string signer_digest;
  bool microsoft_signer = false;
  // The no-write/no-delete share lock remains held while trust metadata is
  // read by path, so the bytes verified here cannot be swapped underneath the
  // Authenticode APIs.
  ReadAuthenticodeSignerDigest(file, path, &signer_digest,
                               &microsoft_signer);
  const std::string path_utf8 = Utf8FromWide(path);
  if (path_utf8.empty() || path_utf8.size() > 4'096)
    return false;
  std::wstring display_path = path;
  const auto slash = display_path.find_last_of(L"\\/");
  std::wstring display = slash == std::wstring::npos
                             ? display_path
                             : display_path.substr(slash + 1);
  const auto extension = display.rfind(L'.');
  if (extension != std::wstring::npos)
    display.resize(extension);
  const std::string display_name = BoundedUtf8(Utf8FromWide(display), 256);
  std::string policy_language = PolicyLanguageForWindowsExecutable(path);
  if (policy_language == "unknown" && IsAcceptanceFixtureExecutable(path) &&
      !signer_digest.empty() && signer_digest == CurrentHelperSignerDigest())
    policy_language = "en";
  std::string normalized_path = path_utf8;
  for (char &character : normalized_path)
    if (character >= 'A' && character <= 'Z')
      character = static_cast<char>(character + ('a' - 'A'));
  const std::string identity_digest =
      signer_digest.empty()
          ? Sha256String("computer-win-identity-v1-unsigned\n" +
                         executable_digest)
          : Sha256String("computer-win-identity-v1-signed\n" + normalized_path +
                         "\n" + signer_digest);
  *output = {path,
             path_utf8,
             executable_digest,
             signer_digest,
             identity_digest,
             WindowsV1DisplayName(display_name),
             policy_language,
             microsoft_signer,
             file_identity};
  return true;
}

bool OpenLockedWindowsExecutable(const std::wstring &path,
                                 LockedWindowsExecutable *output) {
  if (output == nullptr)
    return false;
  output->file = INVALID_HANDLE_VALUE;
  output->identity = {};
  // Deliberately allow read sharing only. Existing or future handles with
  // write/delete access make this open fail, preventing executable
  // swap/restore between identity verification and CreateProcessW.
#if defined(SPRINT_CODER_COMPUTER_USE_TEST_HANG)
  WindowsTestHang(WindowsTestHangPoint::CreateFileW);
#endif
  ScopedKernelHandle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                     OPEN_EXISTING,
                                     FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (file.value == INVALID_HANDLE_VALUE)
    return false;
  WindowsExecutableIdentity identity;
  if (!BuildLockedWindowsExecutableIdentity(file.value, &identity))
    return false;
  output->identity = std::move(identity);
  output->file = file.release();
  return true;
}

bool BuildWindowsExecutableIdentity(const std::wstring &path,
                                    WindowsExecutableIdentity *output) {
  LockedWindowsExecutable locked;
  if (!OpenLockedWindowsExecutable(path, &locked))
    return false;
  *output = locked.identity;
  CloseLockedWindowsExecutable(&locked);
  return true;
}

bool OpenLockedProcessExecutable(HANDLE process,
                                 LockedWindowsExecutable *output) {
  std::wstring process_path;
  return ReadProcessPath(process, &process_path) &&
         OpenLockedWindowsExecutable(process_path, output);
}

bool OpenLockedProcessExecutable(std::uint32_t pid,
                                 LockedWindowsExecutable *output) {
  ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (process.value == nullptr)
    return false;
  return OpenLockedProcessExecutable(process.value, output);
}

bool WindowsExecutableIdentityMatches(
    const WindowsExecutableIdentity &actual, std::string_view identity_digest,
    std::string_view executable_digest, std::string_view signer_digest) {
  return actual.identity_digest == identity_digest &&
         actual.executable_digest == executable_digest &&
         (signer_digest.empty() ? actual.signer_digest.empty()
                                : actual.signer_digest == signer_digest);
}

bool WindowsExecutableBindingMatches(
    const WindowsFileIdentity &recorded, std::string_view executable_digest,
    std::string_view signer_digest, std::string_view policy_language,
    const WindowsFileIdentity &held, const WindowsExecutableIdentity &current) {
  return SameWindowsFileIdentity(held, recorded) &&
         SameWindowsFileIdentity(held, current.file_identity) &&
         executable_digest == current.executable_digest &&
         signer_digest == current.signer_digest &&
         policy_language == current.policy_language;
}

bool WindowsSessionExecutableMatches(
    const WindowsSession &session,
    const LockedWindowsExecutable &current_executable) {
  WindowsFileIdentity held_identity;
  return session.executable_file != INVALID_HANDLE_VALUE &&
         current_executable.file != INVALID_HANDLE_VALUE &&
         ReadWindowsFileIdentity(session.executable_file, &held_identity) &&
         WindowsExecutableBindingMatches(
             {session.executable_volume_serial, session.executable_file_id},
             session.executable_digest, session.signer_digest,
             session.policy_language, held_identity, current_executable.identity);
}

bool IsPolicyLanguageSupported(std::string_view language) {
  return language == "en" || language == "ja";
}

bool IsTrustedSystemNotepad(const WindowsExecutableIdentity &identity) {
  std::vector<wchar_t> system_directory_buffer(32'768, L'\0');
  const UINT length = GetSystemDirectoryW(
      system_directory_buffer.data(),
      static_cast<UINT>(system_directory_buffer.size()));
  if (length == 0 ||
      static_cast<std::size_t>(length) >= system_directory_buffer.size())
    return false;
  std::wstring system_directory(system_directory_buffer.data(), length);
  if (!system_directory.empty() && system_directory.back() != L'\\')
    system_directory.push_back(L'\\');
  system_directory += L"note" L"pad.exe";
  return identity.microsoft_signer &&
         identity.path.size() == system_directory.size() &&
         CompareStringOrdinal(identity.path.c_str(),
                              static_cast<int>(identity.path.size()),
                              system_directory.c_str(),
                              static_cast<int>(system_directory.size()), TRUE) ==
             CSTR_EQUAL;
}

std::string MaximumModeForWindowsExecutable(
    const WindowsExecutableIdentity &identity) {
  if (!IsPolicyLanguageSupported(identity.policy_language))
    return "observe_only";
  if (IsTrustedSystemNotepad(identity))
    return "full_access_app";
  const std::string helper_signer = CurrentHelperSignerDigest();
  if (IsAcceptanceFixtureExecutable(identity.path) &&
      !helper_signer.empty() && identity.signer_digest == helper_signer)
    return "full_access_app";
  return "observe_only";
}

bool IsSupportedWindowsV1Target(
    const WindowsExecutableIdentity &identity) {
  return MaximumModeForWindowsExecutable(identity) == "full_access_app";
}

