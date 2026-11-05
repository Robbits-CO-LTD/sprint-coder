// The target can erase its PEB environment. Image mappings and the user's CLR
// registry are checked independently; environment entries remain extra denials.
#pragma once

inline constexpr std::size_t kWindowsIlEnvironmentMaxChars = 32768;

bool WindowsIlEnvironmentBlockSafe(std::span<const wchar_t> block) {
  if (block.size() < 2 || block.size() > kWindowsIlEnvironmentMaxChars ||
      block[block.size() - 1] != L'\0' || block[block.size() - 2] != L'\0') return false;
  if (block.size() == 2 && block[0] == L'\0') return true;
  std::size_t offset = 0;
  while (offset < block.size() - 1) {
    const auto start = offset;
    while (offset < block.size() && block[offset] != L'\0') ++offset;
    if (offset == start || offset == block.size()) return false;
    const std::wstring_view entry(block.data() + start, offset - start);
    // Windows drive-current-directory entries start with '=' (for example '=C:=C:\').
    const auto equals = entry.find(L'=', entry[0] == L'=' ? 1 : 0);
    if (equals == std::wstring_view::npos || equals == 0) return false;
    std::wstring name(entry.substr(0, equals));
    for (auto &c : name) if (c >= L'a' && c <= L'z') c -= L'a' - L'A';
    if (name.starts_with(L"COR_") || name.starts_with(L"CORECLR_") ||
        name.starts_with(L"COMPLUS_")) return false;
    if (name.starts_with(L"DOTNET_") &&
        (name == L"DOTNET_SHARED_STORE" || name.starts_with(L"DOTNET_ROOT") ||
         name.find(L"PROFIL") != std::wstring::npos || name.find(L"HOOK") != std::wstring::npos ||
         name.find(L"DEPS") != std::wstring::npos || name.find(L"PROBING") != std::wstring::npos)) return false;
    ++offset;
  }
  return offset == block.size() - 1;
}

// PEB/RTL_USER_PROCESS_PARAMETERS layouts differ for WOW64. Reads are bounded and
// page-sized; unreadable pointers, missing terminators and changing blocks deny admission.
template <typename Read>
std::optional<std::vector<wchar_t>> WindowsReadIlEnvironment(std::uintptr_t peb, bool wide, Read read) {
  const auto pointer = [&](std::uintptr_t address) -> std::optional<std::uintptr_t> {
    std::uint64_t value = 0;
    if (!read(address, &value, wide ? 8 : 4) || value == 0 ||
        value > UINTPTR_MAX) return std::nullopt;
    return static_cast<std::uintptr_t>(value);
  };
  if (peb == 0 || peb > UINTPTR_MAX - 0x20) return std::nullopt;
  const auto parameters = pointer(peb + (wide ? 0x20 : 0x10));
  if (!parameters || *parameters > UINTPTR_MAX - 0x80) return std::nullopt;
  const auto environment = pointer(*parameters + (wide ? 0x80 : 0x48));
  if (!environment || (*environment % sizeof(wchar_t)) != 0) return std::nullopt;
  std::vector<wchar_t> block;
  while (block.size() < kWindowsIlEnvironmentMaxChars) {
    const auto bytes = block.size() * sizeof(wchar_t);
    if (*environment > UINTPTR_MAX - bytes) return std::nullopt;
    const auto address = *environment + bytes;
    const auto chars = std::min<std::size_t>((4096 - (address % 4096)) / sizeof(wchar_t),
                                           kWindowsIlEnvironmentMaxChars - block.size());
    std::array<wchar_t, 2048> chunk{};
    if (!read(address, chunk.data(), chars * sizeof(wchar_t))) return std::nullopt;
    for (std::size_t i = 0; i < chars; ++i) {
      block.push_back(chunk[i]);
      if (block.size() >= 2 && block.back() == L'\0' && block[block.size() - 2] == L'\0')
        return block;
    }
  }
  return std::nullopt;
}

template <typename Open, typename Query, typename Close>
bool WindowsIlRegistryKeyEmptyWith(HKEY hive, REGSAM view, const wchar_t *path,
                                   Open open, Query query, Close close) {
  HKEY key = nullptr;
  const LSTATUS opened = open(hive, path, 0, KEY_QUERY_VALUE | view, &key);
  if (opened == ERROR_FILE_NOT_FOUND) return true;
  if (opened != ERROR_SUCCESS) return false;
  DWORD values = 0;
  const LSTATUS queried = query(key, nullptr, nullptr, nullptr, nullptr,
      nullptr, nullptr, &values, nullptr, nullptr, nullptr, nullptr);
  close(key);
  return queried == ERROR_SUCCESS && values == 0;
}

bool WindowsIlRegistryKeyEmpty(HKEY hive, REGSAM view,
                               const wchar_t *path = L"Software\\Microsoft\\.NETFramework") {
  return WindowsIlRegistryKeyEmptyWith(hive, view, path, RegOpenKeyExW, RegQueryInfoKeyW, RegCloseKey);
}

bool WindowsIlUserSidsMatch(PSID target, PSID self) {
  return target && self && IsValidSid(target) && IsValidSid(self) && EqualSid(target, self);
}

bool WindowsIlOnlyRegistrySafe(HANDLE process, bool wow64) {
  ScopedKernelHandle target, self;
  if (!OpenProcessToken(process, TOKEN_QUERY, &target.value) ||
      !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &self.value)) return false;
  const auto user = [](HANDLE token) -> std::optional<std::vector<BYTE>> {
    DWORD needed = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &needed);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || needed == 0 || needed > 65536)
      return std::nullopt;
    std::vector<BYTE> bytes(needed);
    if (!GetTokenInformation(token, TokenUser, bytes.data(), needed, &needed)) return std::nullopt;
    return bytes;
  };
  const auto target_user = user(target.value), self_user = user(self.value);
  if (!target_user || !self_user || !WindowsIlUserSidsMatch(
      reinterpret_cast<const TOKEN_USER *>(target_user->data())->User.Sid,
      reinterpret_cast<const TOKEN_USER *>(self_user->data())->User.Sid)) return false;
  HKEY hive = nullptr;
  if (RegOpenCurrentUser(KEY_READ, &hive) != ERROR_SUCCESS) return false;
  const bool safe = WindowsIlRegistryKeyEmpty(hive, KEY_WOW64_64KEY) &&
      (!wow64 || (WindowsIlRegistryKeyEmpty(hive, KEY_WOW64_32KEY) &&
          WindowsIlRegistryKeyEmpty(hive, KEY_WOW64_32KEY,
              L"Software\\Wow6432Node\\Microsoft\\.NETFramework")));
  RegCloseKey(hive);
  return safe;
}

bool WindowsIlImageUnderRoot(const std::wstring &path, const std::wstring &root) {
  return path.size() > root.size() && path[root.size()] == L'\\' &&
      CompareStringOrdinal(path.data(), static_cast<int>(root.size()), root.data(),
                           static_cast<int>(root.size()), TRUE) == CSTR_EQUAL;
}

std::optional<std::wstring> WindowsIlImageRoot(const std::wstring &path) {
  ScopedKernelHandle directory(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (directory.value == INVALID_HANDLE_VALUE ||
      !GetFileInformationByHandleEx(directory.value, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return std::nullopt;
  std::vector<wchar_t> name(32768);
  const DWORD length = GetFinalPathNameByHandleW(directory.value, name.data(),
      static_cast<DWORD>(name.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_NT);
  if (length == 0 || length >= name.size()) return std::nullopt;
  return std::wstring(name.data(), length);
}

inline constexpr std::size_t kWindowsIlImageAclMaxObjects = 4096;
inline constexpr ULONGLONG kWindowsIlImageAclMaxMs = 5000;

// One admission/recheck only: never retain successful ACL checks across calls.
struct WindowsIlImageAclCache {
  std::vector<std::wstring> files, directories;
  ULONGLONG started = GetTickCount64();
};

bool WindowsIlImageAclInspect(const std::wstring &path, bool directory) {
  ScopedKernelHandle held(CreateFileW((L"\\\\?\\GLOBALROOT" + path).c_str(),
      READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (held.value == INVALID_HANDLE_VALUE || !WindowsIlAclObject(held.value, directory)) return false;
  std::array<wchar_t, 32768> name{};
  const DWORD length = GetFinalPathNameByHandleW(held.value, name.data(),
      static_cast<DWORD>(name.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_NT);
  return length && length < name.size() && SameWindowsTargetName(path, std::wstring(name.data(), length));
}

template <typename Inspect, typename Clock>
bool WindowsIlImageAclSafe(const std::wstring &path, const std::wstring &root,
                           WindowsIlImageAclCache &cache, Inspect inspect, Clock clock) {
  const auto check = [&](const std::wstring &name, bool directory) {
    if (clock() - cache.started >= kWindowsIlImageAclMaxMs) return false;
    auto &known = directory ? cache.directories : cache.files;
    if (std::any_of(known.begin(), known.end(), [&](const auto &item) {
          return SameWindowsTargetName(item, name);
        })) return true;
    if (cache.files.size() + cache.directories.size() >= kWindowsIlImageAclMaxObjects ||
        !inspect(name, directory) || clock() - cache.started >= kWindowsIlImageAclMaxMs) return false;
    known.push_back(name);
    return true;
  };
  if (!WindowsIlImageUnderRoot(path, root) || !check(path, false)) return false;
  auto parent = path;
  for (unsigned depth = 0; depth < 128; ++depth) {
    const auto slash = parent.find_last_of(L'\\');
    if (slash == std::wstring::npos) return false;
    parent.resize(slash);
    if (parent.size() < root.size() || !check(parent, true)) return false;
    if (SameWindowsTargetName(parent, root)) return true;
  }
  return false;
}

bool WindowsIlOnlyImagesSafe(HANDLE process) {
  WindowsIlImageAclCache acl;
  std::array<wchar_t, 32768> image{}, windows{};
  DWORD size = static_cast<DWORD>(image.size());
  const UINT length = GetSystemWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()));
  if (!length || length >= windows.size() ||
      !QueryFullProcessImageNameW(process, 0, image.data(), &size)) return false;
  const std::wstring executable(image.data(), size), system(windows.data(), length);
  const auto slash = executable.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return false;
  std::vector<std::wstring> roots;
  for (const auto &path : {executable.substr(0, slash), system + L"\\System32",
      system + L"\\SysWOW64", system + L"\\WinSxS", system + L"\\Microsoft.NET\\Framework",
      system + L"\\Microsoft.NET\\Framework64"}) {
    const auto root = WindowsIlImageRoot(path);
    if (!root) return false;
    roots.push_back(*root);
  }
  for (const auto &assembly : {system + L"\\assembly", system + L"\\Microsoft.NET\\assembly"}) {
    for (const auto *leaf : {L"GAC", L"GAC_32", L"GAC_64", L"GAC_MSIL",
        L"NativeImages_v2.0.50727_32", L"NativeImages_v2.0.50727_64",
        L"NativeImages_v4.0.30319_32", L"NativeImages_v4.0.30319_64"}) {
      const auto path = assembly + L"\\" + leaf;
      const DWORD attributes = GetFileAttributesW(path.c_str());
      if (attributes == INVALID_FILE_ATTRIBUTES) {
        const DWORD error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) continue;
        return false;
      }
      const auto root = WindowsIlImageRoot(path);
      if (!root) return false;
      roots.push_back(*root);
    }
  }
  std::uintptr_t address = 0;
  bool found = false;
  for (unsigned queried = 0; queried < 65536; ++queried) {
    if (GetTickCount64() - acl.started >= kWindowsIlImageAclMaxMs) return false;
    MEMORY_BASIC_INFORMATION region{};
    if (VirtualQueryEx(process, reinterpret_cast<LPCVOID>(address), &region, sizeof(region)) != sizeof(region))
      return found && GetLastError() == ERROR_INVALID_PARAMETER &&
          GetTickCount64() - acl.started < kWindowsIlImageAclMaxMs;
    if (region.Type == MEM_IMAGE) {
      std::array<wchar_t, 32768> name{};
      const DWORD count = GetMappedFileNameW(process, region.BaseAddress, name.data(), static_cast<DWORD>(name.size()));
      if (!count || count >= name.size()) return false;
      // Mapped names can retain 8.3 aliases. Normalize through a non-reparse handle,
      // just like the roots, and fail closed if the mapped file cannot be resolved.
      const auto path = WindowsIlImageRoot(L"\\\\?\\GLOBALROOT" + std::wstring(name.data(), count));
      if (!path) return false;
      const auto root = std::find_if(roots.begin(), roots.end(), [&](const auto &root) {
            return WindowsIlImageUnderRoot(*path, root);
          });
      if (root == roots.end()) return false;
      // The executable tree has its own full ACL snapshot. External images must
      // prove file ownership/writes AND every parent through the allowed root.
      // Re-evaluate at existing environment gates (including start/resume/rejudge),
      // rather than extending the executable snapshot or its retained input pins.
      if (root != roots.begin() &&
          !WindowsIlImageAclSafe(*path, *root, acl, WindowsIlImageAclInspect, GetTickCount64)) return false;
      found = true;
    }
    const auto base = reinterpret_cast<std::uintptr_t>(region.BaseAddress);
    if (!region.RegionSize || base > UINTPTR_MAX - region.RegionSize || base + region.RegionSize <= address)
      return false;
    address = base + region.RegionSize;
  }
  return false;
}

bool WindowsIlOnlyEnvironmentSafe(HANDLE process) {
  using Query = LONG(WINAPI *)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  const auto module = GetModuleHandleW(L"ntdll.dll");
  const auto query = module ? reinterpret_cast<Query>(GetProcAddress(module, "NtQueryInformationProcess")) : nullptr;
  if (!query) return false;
  BOOL wow64 = FALSE;
  if (!IsWow64Process(process, &wow64)) return false;
  if (!WindowsIlOnlyRegistrySafe(process, wow64 != FALSE) || !WindowsIlOnlyImagesSafe(process)) return false;
  std::uintptr_t peb = 0;
  if (wow64) {
    if (query(process, 26 /* ProcessWow64Information */, &peb, sizeof(peb), nullptr) < 0) return false;
  } else {
    struct Basic { PVOID reserved; PVOID peb; PVOID reserved2[2]; ULONG_PTR pid; PVOID reserved3; } basic{};
    if (query(process, 0 /* ProcessBasicInformation */, &basic, sizeof(basic), nullptr) < 0) return false;
    peb = reinterpret_cast<std::uintptr_t>(basic.peb);
  }
  const auto read = [&](std::uintptr_t address, void *buffer, std::size_t size) {
    SIZE_T received = 0;
    return ReadProcessMemory(process, reinterpret_cast<LPCVOID>(address), buffer, size, &received) && received == size;
  };
  const bool wide = sizeof(void *) == 8 && !wow64;
  const auto first = WindowsReadIlEnvironment(peb, wide, read);
  if (!first || !WindowsIlEnvironmentBlockSafe(*first)) return false;
  const auto second = WindowsReadIlEnvironment(peb, wide, read);
  return second && *first == *second;
}

bool WindowsIlOnlyEnvironmentSafeForSnapshot(DWORD pid, const std::string &snapshot) {
  if (snapshot.empty()) return true;
  ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid));
  return process.value && WindowsIlOnlyEnvironmentSafe(process.value);
}
