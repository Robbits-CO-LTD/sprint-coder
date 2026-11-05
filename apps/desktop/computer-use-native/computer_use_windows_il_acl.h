// IL-only images require a protected code tree and directory chain. Unknown trustees
// may read, but only SYSTEM, Administrators and TrustedInstaller may own or write. Loaded images
// outside that tree also accept service SIDs (S-1-5-80-*, S-1-5-99-*), which standard users cannot hold.
#pragma once

bool WindowsIlAclTrustedSid(PSID sid) {
  if (!sid || !IsValidSid(sid)) return false;
  if (IsWellKnownSid(sid, WinLocalSystemSid) ||
      IsWellKnownSid(sid, WinBuiltinAdministratorsSid)) return true;
  SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
  PSID installer = nullptr;
  if (!AllocateAndInitializeSid(&authority, 6, 80, 956008885, 3418522649,
                                1831038044, 1853292631, 2271478464, 0, 0, &installer))
    return false;
  const bool trusted = EqualSid(sid, installer) != FALSE;
  FreeSid(installer);
  return trusted;
}

bool WindowsIlAclDescriptorSafe(PSECURITY_DESCRIPTOR descriptor, bool directory = false,
                                bool (*trusted)(PSID) = WindowsIlAclTrustedSid) {
  if (!descriptor || !IsValidSecurityDescriptor(descriptor)) return false;
  PSID owner = nullptr;
  BOOL defaulted = FALSE, present = FALSE;
  PACL acl = nullptr;
  SECURITY_DESCRIPTOR_CONTROL control{};
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
      (control & SE_DACL_AUTO_INHERIT_REQ) != 0 ||
      !GetSecurityDescriptorOwner(descriptor, &owner, &defaulted) ||
      !trusted(owner) || defaulted ||
      !GetSecurityDescriptorDacl(descriptor, &present, &acl, &defaulted) ||
      !present || !acl || defaulted || !IsValidAcl(acl)) return false;
  for (DWORD index = 0; index < acl->AceCount; ++index) {
    void *raw = nullptr;
    if (!GetAce(acl, index, &raw)) return false;
    const auto *header = static_cast<const ACE_HEADER *>(raw);
    // Conditional and object ACEs, even denies, need semantics not supported here.
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE &&
        header->AceType != ACCESS_DENIED_ACE_TYPE) return false;
    if ((header->AceFlags & ~(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE |
                              NO_PROPAGATE_INHERIT_ACE | INHERIT_ONLY_ACE | INHERITED_ACE)) != 0 ||
        header->AceSize < FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart) + 8) return false;
    const auto *ace = static_cast<const ACCESS_ALLOWED_ACE *>(raw);
    PSID sid = const_cast<DWORD *>(&ace->SidStart);
    const auto sid_bytes = header->AceSize - FIELD_OFFSET(ACCESS_ALLOWED_ACE, SidStart);
    if (GetSidLengthRequired(*GetSidSubAuthorityCount(sid)) > sid_bytes || !IsValidSid(sid))
      return false;
    // Inherit-only writes can grant control over future code/configuration children.
    if ((header->AceFlags & INHERIT_ONLY_ACE) != 0) {
      if ((header->AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) == 0) return false;
    }
    // A deny never cancels an unsafe allow: no inferred ordering or membership.
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
    DWORD mask = ace->Mask;
    MapGenericMask(&mask, &mapping);
    constexpr DWORD read_only = FILE_READ_DATA | FILE_READ_EA | FILE_EXECUTE |
                                FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
    // These placeholders reach only children created by an already authorized
    // writer. Every other untrusted write grant still rejects this descriptor.
    const bool creator = directory && (header->AceFlags & INHERIT_ONLY_ACE) != 0 &&
        (IsWellKnownSid(sid, WinCreatorOwnerSid) || IsWellKnownSid(sid, WinCreatorGroupSid));
    if ((mask & ~read_only) != 0 && !trusted(sid) && !creator) return false;
  }
  return true;
}

std::optional<std::string> WindowsIlAclObject(HANDLE file, bool directory,
                                             bool (*trusted)(PSID) = WindowsIlAclTrustedSid) {
  FILE_ATTRIBUTE_TAG_INFO tag{};
  WindowsFileIdentity identity;
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      ((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory ||
      !ReadWindowsFileIdentity(file, &identity)) return std::nullopt;
  constexpr SECURITY_INFORMATION wanted = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  DWORD needed = 0;
  GetKernelObjectSecurity(file, wanted, nullptr, 0, &needed);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || needed == 0 || needed > 128 * 1024)
    return std::nullopt;
  std::vector<std::uint8_t> bytes(needed);
  if (!GetKernelObjectSecurity(file, wanted, bytes.data(), needed, &needed) ||
      !WindowsIlAclDescriptorSafe(bytes.data(), directory, trusted)) return std::nullopt;
  // Exact descriptor bytes and IDs, length-delimited, retained only in memory.
  std::string result(reinterpret_cast<const char *>(&identity.volume_serial), sizeof(identity.volume_serial));
  result.append(reinterpret_cast<const char *>(identity.file_id.Identifier), sizeof(identity.file_id.Identifier));
  result.append(reinterpret_cast<const char *>(&needed), sizeof(needed));
  result.append(reinterpret_cast<const char *>(bytes.data()), needed);
  return result;
}

inline constexpr std::size_t kWindowsIlAclMaxEntries = 4096;
inline constexpr unsigned kWindowsIlAclMaxDepth = 8;

std::optional<std::string> WindowsIlAclHash(const std::string &bytes) {
  std::array<BYTE, 32> hash{};
  DWORD size = static_cast<DWORD>(hash.size());
  if (!CryptHashCertificate2(BCRYPT_SHA256_ALGORITHM, 0, nullptr,
      reinterpret_cast<const BYTE *>(bytes.data()), static_cast<DWORD>(bytes.size()),
      hash.data(), &size) || size != hash.size()) return std::nullopt;
  return std::string(reinterpret_cast<const char *>(hash.data()), hash.size());
}

struct WindowsIlAclEntry {
  std::wstring name;
  bool directory = false;
  bool reparse = false;
};

std::optional<std::vector<WindowsIlAclEntry>> WindowsIlAclList(const std::wstring &path) {
  WIN32_FIND_DATAW data{};
  HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &data);
  if (search == INVALID_HANDLE_VALUE) return std::nullopt;
  struct Search { HANDLE value; ~Search() { FindClose(value); } } held{search};
  std::vector<WindowsIlAclEntry> entries;
  do {
    const std::wstring name(data.cFileName);
    if (name == L"." || name == L"..") continue;
    if (entries.size() == kWindowsIlAclMaxEntries) return std::nullopt;
    entries.push_back({name, (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0,
                            (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0});
  } while (FindNextFileW(search, &data));
  if (GetLastError() != ERROR_NO_MORE_FILES) return std::nullopt;
  return entries;
}

// Every object, including the root, contributes its name, file ID and descriptor digest.
template <typename List, typename Inspect>
std::optional<std::string> WindowsIlAclTree(const std::wstring &root, List list, Inspect inspect) {
  std::size_t count = 0;
  std::string summary;
  const auto visit = [&](auto &&self, const std::wstring &path, bool directory,
                         unsigned depth) -> bool {
    if (depth > kWindowsIlAclMaxDepth || count == kWindowsIlAclMaxEntries) return false;
    ++count;
    const auto object = inspect(path, directory);
    if (!object) return false;
    std::string record(reinterpret_cast<const char *>(path.data()), path.size() * sizeof(wchar_t));
    record.append(2, '\0');
    record.append(*object);
    const auto hash = WindowsIlAclHash(record);
    if (!hash) return false;
    summary.append(*hash);
    if (!directory) return true;
    auto entries = list(path);
    if (!entries || entries->size() > kWindowsIlAclMaxEntries - count) return false;
    std::sort(entries->begin(), entries->end(), [](const auto &a, const auto &b) { return a.name < b.name; });
    std::wstring previous;
    for (const auto &entry : *entries) {
      if (entry.reparse || entry.name.empty() || entry.name == L"." || entry.name == L".." ||
          entry.name.find_first_of(L"\\/:") != std::wstring::npos || entry.name == previous) return false;
      previous = entry.name;
      if (!self(self, path + L"\\" + entry.name, entry.directory, depth + 1)) return false;
    }
    return true;
  };
  if (!visit(visit, root, true, 0)) return std::nullopt;
  const auto hash = WindowsIlAclHash(summary);
  if (!hash) return std::nullopt;
  return std::to_string(count) + ":" + *hash;
}

std::optional<std::string> WindowsIlAclTreeSnapshot(const std::wstring &root) {
  return WindowsIlAclTree(root, WindowsIlAclList,
      [](const std::wstring &path, bool directory) -> std::optional<std::string> {
    ScopedKernelHandle held(CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (held.value == INVALID_HANDLE_VALUE) return std::nullopt;
    std::wstring canonical;
    if (!CanonicalWindowsPathFromHandle(held.value, &canonical) ||
        !SameWindowsTargetName(path, canonical)) return std::nullopt;
    return WindowsIlAclObject(held.value, directory);
  });
}

bool WindowsIlOnlyPlacementSafe(const std::optional<std::string> &root, bool package_override) {
  return root == "windows_directory" || root == "program_files" ||
      (root == "windows_apps" && !package_override);
}

// Bounded retained handles for the input fast path. Admission and reclassification
// always produce a full snapshot. Eviction merely requires another full check.
struct WindowsIlAclPins {
  std::string snapshot;
  std::vector<HANDLE> handles;
  std::vector<std::wstring> paths;
  LONGLONG root_write = 0;
  ~WindowsIlAclPins() { for (HANDLE handle : handles) CloseHandle(handle); }
};
SRWLOCK windows_il_acl_pins_lock = SRWLOCK_INIT;
std::array<WindowsIlAclPins, 16> windows_il_acl_pins;
std::size_t windows_il_acl_pin_next = 0;

std::optional<LONGLONG> WindowsIlDirectoryWrite(HANDLE directory) {
  FILE_BASIC_INFO info{};
  if (!GetFileInformationByHandleEx(directory, FileBasicInfo, &info, sizeof(info))) return std::nullopt;
  return info.LastWriteTime.QuadPart;
}

void WindowsIlRememberPins(const std::string &snapshot, HANDLE file,
                          const std::vector<HANDLE> &directories, LONGLONG root_write) {
  WindowsIlAclPins pending;
  pending.snapshot = snapshot;
  pending.root_write = root_write;
  auto retain = [&](HANDLE handle) {
    std::wstring path;
    if (!CanonicalWindowsPathFromHandle(handle, &path)) return false;
    // Cache entries can outlive a session. Keep identity handles without extending
    // its executable write/delete lock; the session itself owns that lock.
    HANDLE duplicate = CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (duplicate == INVALID_HANDLE_VALUE) return false;
    pending.handles.push_back(duplicate);
    pending.paths.push_back(std::move(path));
    return true;
  };
  if (!retain(file)) return;
  for (HANDLE handle : directories) if (!retain(handle)) return;
  AcquireSRWLockExclusive(&windows_il_acl_pins_lock);
  auto existing = std::find_if(windows_il_acl_pins.begin(), windows_il_acl_pins.end(),
      [&](const auto &pins) { return pins.snapshot == snapshot; });
  auto &slot = existing != windows_il_acl_pins.end() ? *existing :
      windows_il_acl_pins[windows_il_acl_pin_next++ % windows_il_acl_pins.size()];
  slot.snapshot.swap(pending.snapshot);
  slot.handles.swap(pending.handles);
  slot.paths.swap(pending.paths);
  slot.root_write = root_write;
  ReleaseSRWLockExclusive(&windows_il_acl_pins_lock);
}

std::optional<std::string> WindowsIlOnlyAclSnapshot(HANDLE file) {
  std::wstring path;
  if (!CanonicalWindowsPathFromHandle(file, &path)) return std::nullopt;
  const auto roots = CurrentWindowsTargetRoots(L"");
  if (!roots) return std::nullopt;
  const auto utf8 = WindowsTargetUtf8(path);
  if (!utf8) return std::nullopt;
  std::wstring root;
  for (const auto &candidate : *roots) {
    if (candidate.root != "windows_directory" && candidate.root != "program_files" &&
        candidate.root != "windows_apps") continue;
    const sprint_coder::computer_use::WindowsImageRootPrefix one[] = {candidate};
    if (sprint_coder::computer_use::PlaceWindowsImage(*utf8, one).root == candidate.root) {
      const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, candidate.prefix.data(),
                                              static_cast<int>(candidate.prefix.size()), nullptr, 0);
      if (length <= 0) return std::nullopt;
      root.resize(length);
      if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, candidate.prefix.data(),
                              static_cast<int>(candidate.prefix.size()), root.data(), length))
        return std::nullopt;
      break;
    }
  }
  if (root.empty()) return std::nullopt;
  // WindowsApps IL-only remains denied: its ACLs include unsupported ACEs or
  // cannot be read/enumerated. Placement alone never bypasses the ACL gate.
  const auto slash = path.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return std::nullopt;
  const auto image_directory = path.substr(0, slash);
  // Existing .config/.manifest sidecars are part of the tree. If absent, the
  // directory ACL must still deny untrusted creation, including inherit-only grants.
  const auto tree = WindowsIlAclTreeSnapshot(image_directory);
  if (!tree) return std::nullopt;
  auto result = WindowsIlAclObject(file, false);
  if (!result) return std::nullopt;
  struct Directories {
    std::vector<HANDLE> handles;
    ~Directories() { for (HANDLE handle : handles) CloseHandle(handle); }
  } directories;
  // Retain handles for identity/ACL rereads. These do not prevent every ancestor
  // rename; canonical names and the complete tree are checked again.
  for (unsigned depth = 0; depth < 128; ++depth) {
    const auto slash = path.find_last_of(L"\\/");
    if (slash == std::wstring::npos) return std::nullopt;
    path.resize(slash);
    if (path.size() < root.size()) return std::nullopt;
    HANDLE handle = CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) return std::nullopt;
    directories.handles.push_back(handle);
    std::wstring canonical;
    const auto part = WindowsIlAclObject(handle, true);
    if (!part || !CanonicalWindowsPathFromHandle(handle, &canonical) ||
        !SameWindowsTargetName(path, canonical)) return std::nullopt;
    result->append(*part);
    if (!SameWindowsTargetName(path, root)) continue;
    const auto root_write = WindowsIlDirectoryWrite(directories.handles.front());
    if (!root_write) return std::nullopt;
    auto again = WindowsIlAclObject(file, false);
    if (!again) return std::nullopt;
    for (HANDLE held : directories.handles) {
      const auto check = WindowsIlAclObject(held, true);
      if (!check) return std::nullopt;
      again->append(*check);
    }
    const auto tree_again = WindowsIlAclTreeSnapshot(image_directory);
    if (!tree_again || tree_again != tree || again != result ||
        WindowsIlDirectoryWrite(directories.handles.front()) != root_write) return std::nullopt;
    result->append(*tree);
    WindowsIlRememberPins(*result, file, directories.handles, *root_write);
    return result;
  }
  return std::nullopt;
}

bool WindowsIlOnlyAclUnchanged(HANDLE file, const std::string &snapshot) {
  if (snapshot.empty()) return true; // Native images have no IL-only snapshot.
  const auto current = WindowsIlOnlyAclSnapshot(file);
  return current && *current == snapshot;
}

bool WindowsIlOnlyAclInputUnchanged(HANDLE file, const std::string &snapshot) {
  if (snapshot.empty()) return true;
  bool unchanged = false;
  AcquireSRWLockShared(&windows_il_acl_pins_lock);
  for (const auto &pins : windows_il_acl_pins) {
    if (pins.snapshot != snapshot || pins.handles.size() < 2) continue;
    auto current = WindowsIlAclObject(file, false);
    const auto retained = WindowsIlAclObject(pins.handles.front(), false);
    std::wstring path;
    if (!current || current != retained || !CanonicalWindowsPathFromHandle(file, &path) ||
        !SameWindowsTargetName(path, pins.paths.front())) break;
    bool valid = true;
    for (std::size_t i = 1; i < pins.handles.size(); ++i) {
      const auto descriptor = WindowsIlAclObject(pins.handles[i], true);
      if (!descriptor || !CanonicalWindowsPathFromHandle(pins.handles[i], &path) ||
          !SameWindowsTargetName(path, pins.paths[i])) { valid = false; break; }
      current->append(*descriptor);
    }
    unchanged = valid && snapshot.starts_with(*current) &&
        WindowsIlDirectoryWrite(pins.handles[1]) == std::optional<LONGLONG>(pins.root_write);
    break;
  }
  ReleaseSRWLockShared(&windows_il_acl_pins_lock);
  return unchanged || WindowsIlOnlyAclUnchanged(file, snapshot);
}
