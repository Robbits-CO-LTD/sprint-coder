// BEGIN windows target facts (#500 S5-c-3 PR-2)
// The facts the v2 target eligibility core reads (TargetFacts in
// computer_use_deny_ruleset_generated.h), measured for one process through handles. Nothing calls
// this yet: PR-5 makes list_targets and the v2 start, resume and per-input checks use it. No V1
// path changes: the V1 identity, its embedded-only signer read (ReadAuthenticodeSignerDigest) and
// its allow-list stay as they are. A fact that cannot be measured stays std::nullopt, and the core
// then answers unresolvable; nothing here turns a failure into a value that admits.
//
//   * Running image. The process's path is read first (QueryFullProcessImageNameW, as V1 reads it
//     before it opens the file). The main image is then found from kernel-held data, not from the
//     target's module list (the PEB Ldr list is writable by the target, so its first entry can be
//     made to name another file): NtQueryInformationProcess(ProcessImageInformation) gives the
//     entry point and header summary the kernel recorded at creation, VirtualQueryEx confirms the
//     entry point is in a MEM_IMAGE region, and GetMappedFileNameW on that region's base names the
//     backing file. That file is opened and held without write or delete sharing. The anchor that
//     the held file is the running image is a re-read of QueryFullProcessImageNameW after the hold:
//     it names the kernel's image file object, which follows a rename of the running image, so when
//     a target unmaps its image and maps another file B at the entry point's address (and rewrites
//     its Ldr list), the re-read still names the real image and opens a different file than the one
//     held, which is a mismatch (W-UR). This rests on QueryFullProcessImageNameW following a
//     rename, which a one-time probe confirms (WindowsTargetRenameFollows): it renames a suspended
//     copy of this helper within its directory and then moves it to another directory on the temp
//     volume, and both must be followed. The probe speaks only for the temp volume's file system,
//     so a target matches only when the probe followed and the target's own file system is the same
//     (a target on another file system, e.g. a Dev Drive's ReFS when temp is NTFS, is W-UR until a
//     probe for it exists). The kernel name is read once before the open and once after, both must
//     agree (a rename racing the open is caught, since the file-id compare still ties the opened
//     file to the real image's id), the held file must sit on a volume with a stable 128-bit file
//     id (NTFS or ReFS), and that volume must not be remote (SMB can report "NTFS", so
//     FileRemoteProtocolInfo decides). A hard-link count is not required: Windows servicing
//     hard-links legitimate system binaries (WinSxS), the eligible System32 image among them, and
//     the name and file-id checks already defeat a hard link placed at the old name (it carries the
//     other file's id). The PE header
//     against the kernel summary (entry
//     RVA, subsystem, machine, checksum, image file size, characteristics, stack sizes), the
//     recorded path still naming the held file, the kernel mapped name staying put, and the module
//     list are auxiliary deny-side checks. The held file must also be unchanged since the process
//     was created: its ChangeTime before the creation time (a writer that kept its handle across
//     the image section's creation can rewrite the file afterwards, as in process herpaderping,
//     and the facts would then be of the new bytes; on NTFS and ReFS a data write, SetFileTime
//     and a rename all move ChangeTime); a time that cannot be read, or one at or after the
//     creation, is a mismatch. LastWriteTime is not judged: it may lie in the future for an
//     honest file (a ZIP's DOS local time unpacked in another time zone, a copy from a machine
//     whose clock ran ahead), and a writer who can set ChangeTime back can set it back too. The
//     ChangeTime can be set back by a writer
//     with FILE_WRITE_ATTRIBUTES, and a rewrite before the process object was created is older
//     than it, so this narrows the attack rather than closing it (ADR §10 risk). Any mismatch, or
//     a target whose kernel data or re-read name cannot be read, is W-UR. Every other fact is read
//     from the held file. Residual risk: the
//     header cross-check is not by itself sufficient (checksum is outside the Authenticode hash and
//     an attacker who builds the original image can match the rest), so the defense rests on the
//     re-read naming the real image, which assumes QueryFullProcessImageNameW follows the rename;
//     an OS where it does not would not be protected (to be confirmed before PR-6; ADR §10 risk).
//   * Path, root, leaf, volume. The held file's canonical path (GetFinalPathNameByHandleW) placed
//     among roots canonicalized the same way. The volume is network when the file system says the
//     file is remote, removable for a removable, optical, RAM, USB, SD, MMC, 1394 or file-backed
//     virtual disk, and fixed otherwise; a volume that cannot be asked is not measured.
//   * Signature. WinVerifyTrust on the held file: the embedded signature, or, when the file has
//     none, a catalog that carries its hash. The leaf's thumbprint and O, and
//     CERT_CHAIN_POLICY_MICROSOFT_ROOT, come from the chain WinVerifyTrust verified (not from a
//     comparison of the O). A catalog signature makes the facts more exact but never admits
//     (decision I): outside %WINDIR% a catalog-only file is given to the core as unsigned (the
//     upper class at most), while its O and its Microsoft root still refuse.
//   * Decision K (revocation). WinVerifyTrust runs with WTD_REVOKE_NONE and
//     WTD_CACHE_ONLY_URL_RETRIEVAL, as V1 does: no revocation check and no network. A cache-only
//     revocation check was considered and not taken: (1) for most files the cache holds no
//     revocation data, so the check answers "offline", which must not admit and so changes
//     nothing; (2) when it does answer, the answer depends on what this machine happened to cache,
//     so the same target could be judged differently by two machines or flip within a session;
//     (3) it doubles the WinVerifyTrust cost of every listed target; (4) no CI runner can show a
//     revoked signer, so the path would ship untested. The residual risk is ADR §10 risk 1.
//   * PE subsystem from the held file's header; the manifest's execution level and
//     OriginalFilename from its resources. OriginalFilename is read only when the signature
//     verified (embedded or catalog), and is "" otherwise. The resources are read through the held
//     handle (an image view of it, ReadWindowsTargetResourceSection), never by opening the path
//     again, and found without the loader (FindPeResources), so no .mui file is consulted.
//   * Token. Elevation, another user, another session, a protected process, UIAccess, an integrity
//     level above this process's, and AppContainer. An item that cannot be read is given as the
//     refusing value (true).
//   * Package. Family, full name and publisherId from the process handle, development mode from
//     the package information, SignatureKind from the package catalog (C++/WinRT). PR-4 binds the
//     family and the publisherId to the identity digest (the windows package identity block, below).
//   * Lineage. One kernel snapshot (SystemProcessInformation) gives every process's parent pid
//     and creation time without opening any process; descendants follow parent pids only to
//     processes created no earlier (FindWindowsDescendants), so a reused pid is not a parent.
//     Residual risk: a child whose parent has exited cannot be traced (the system does not
//     reparent it), nor one started with another parent named (PROC_THREAD_ATTRIBUTE_PARENT_
//     PROCESS), so descendant_shell = false says "no shell below that a live chain shows". No
//     orphan signal is used, after weighing these: (a) the target's job (the job's processes
//     cannot be listed without a handle to the job, which a process handle does not give); (b)
//     orphans (same user and session, parent gone, created after the target), which would cap
//     every long-running target at C for any unrelated detached shell the user started later
//     (a terminal closed under its shell, `start` from a closed cmd), and which a hostile target
//     still evades by naming another parent. What the cap is for, an app that hosts a shell or a
//     pseudo console in its own surface, keeps the owner of that console alive below the target
//     (a pseudo console ends with its owner's handle), so a live chain shows it; hiding a shell
//     on purpose is the target lying, which these facts cannot prevent (ADR §10 risk).
//     Each descendant is read from its own running image, held as the target's is: a non-GUI
//     subsystem, or a leaf or OriginalFilename on the W4 table, is a shell, so a renamed copy of
//     a shell is one too; a descendant that cannot be read is taken as a shell. At most
//     kWindowsTargetDescendantInspectLimit descendants within kWindowsTargetDescendantBudgetMs;
//     beyond that the descendant facts are not measured.

// Production builds inject this literal through the generated build header. Standalone harnesses
// default to ordinary mode; no request, environment or mutable context can enable acceptance.
#ifndef SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD
#define SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD 0
#endif
inline constexpr bool kWindowsTargetAcceptanceMode =
    SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD == 1;

inline constexpr std::size_t kWindowsTargetDescendantLimit = 1024;
// The descendants of one target that are read from their images, and the time that may take.
// More than that, or longer: the descendant facts are not measured (unresolvable).
inline constexpr std::size_t kWindowsTargetDescendantInspectLimit = 64;
inline constexpr ULONGLONG kWindowsTargetDescendantBudgetMs = 2'000;
inline constexpr std::string_view kWindowsTargetFixtureLeaf =
    "sprint-coder-computer-use-fixture.exe";

enum class WindowsTargetSignatureSource : std::uint8_t { kNone, kEmbedded, kCatalog };

// A volume's file system (lower-cased name and the FileSystemFlags), read from a held handle.
struct WindowsTargetVolume {
  std::string file_system;
  std::uint32_t flags = 0;
};

// What the one-time rename-follow probe found: whether QueryFullProcessImageNameW follows a rename
// of a running image on the probed volume, and that volume's file system (name and flags).
struct WindowsTargetRenameProbe {
  bool follows = false;
  WindowsTargetVolume volume;
};

// What the caller knows that the target cannot tell: the roots (in precedence order), the process
// whose descendants are Sprint Coder's own, and this helper's signer.
struct WindowsTargetFactsContext {
  std::optional<std::vector<sprint_coder::computer_use::WindowsImageRootPrefix>> roots;
  std::uint32_t lineage_root_pid = 0;
  std::uint64_t lineage_root_creation = 0;
  std::string self_signer_thumbprint;
  // The one-time rename-follow probe (WindowsTargetRenameFollows): whether the kernel image name
  // follows a rename on the probed (temp) volume, and that volume's file system. The running-image
  // anchor rests on it, so a target matches only when the probe followed and the target's own file
  // system is the same as the probed one; otherwise the target is unresolvable.
  std::optional<WindowsTargetRenameProbe> rename_probe;
};

struct WindowsTargetFactsMeasurement {
  sprint_coder::computer_use::TargetFacts facts;
  std::uint32_t pid = 0;
  std::optional<std::uint64_t> creation;
  // The parent, when the snapshot names one created no later than the target.
  std::optional<std::uint32_t> parent_pid;
  std::wstring image_path;
  std::optional<WindowsFileIdentity> file_identity;
  WindowsTargetSignatureSource signature_source = WindowsTargetSignatureSource::kNone;
  std::string signer_thumbprint;
  std::optional<std::string> package_full_name;
  std::optional<std::string> package_publisher_id;
  // The verified package's install location, canonicalized, when the target is a package.
  std::optional<std::string> package_install_root;
};

struct WindowsTargetSignature {
  // "valid", "unsigned" or "invalid", as verified (before decision I).
  std::optional<std::string> state;
  WindowsTargetSignatureSource source = WindowsTargetSignatureSource::kNone;
  std::string thumbprint;
  std::optional<std::string> organization;
  std::optional<bool> microsoft_root;
};

std::optional<std::uint64_t> WindowsTargetCreationTime(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (process == nullptr ||
      GetProcessTimes(process, &created, &exited, &kernel, &user) != TRUE)
    return std::nullopt;
  return (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) |
         created.dwLowDateTime;
}

std::optional<std::string> WindowsTargetUtf8(std::wstring_view value) {
  if (value.empty())
    return std::string{};
  std::string converted = Utf8FromWide(value);
  if (converted.empty())
    return std::nullopt;
  return converted;
}

bool SameWindowsTargetName(std::wstring_view left, std::wstring_view right) {
  return left.size() == right.size() &&
         CompareStringOrdinal(left.data(), static_cast<int>(left.size()),
                              right.data(), static_cast<int>(right.size()),
                              TRUE) == CSTR_EQUAL;
}

// A directory canonicalized the way image paths are, or "" when it cannot be opened.
std::string CanonicalWindowsTargetDirectory(const std::wstring &directory) {
  if (directory.empty())
    return {};
  ScopedKernelHandle handle(CreateFileW(
      directory.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  std::wstring canonical;
  if (handle.value == INVALID_HANDLE_VALUE ||
      !CanonicalWindowsPathFromHandle(handle.value, &canonical))
    return {};
  return Utf8FromWide(canonical);
}

std::wstring WindowsTargetKnownFolder(REFKNOWNFOLDERID folder) {
  PWSTR path = nullptr;
  std::wstring result;
  if (SUCCEEDED(SHGetKnownFolderPath(folder, KF_FLAG_DONT_VERIFY, nullptr,
                                     &path)) &&
      path != nullptr)
    result = path;
  CoTaskMemFree(path);
  return result;
}

// Sprint Coder's own install root: the parent of the helper's `resources` directory in a package,
// or the helper's directory otherwise (a development build).
std::wstring WindowsTargetSelfInstallRoot() {
  std::vector<wchar_t> buffer(32'768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(),
                                          static_cast<DWORD>(buffer.size()));
  if (length == 0 || static_cast<std::size_t>(length) >= buffer.size())
    return {};
  std::wstring directory(buffer.data(), length);
  const std::size_t leaf = directory.find_last_of(L"\\/");
  if (leaf == std::wstring::npos)
    return {};
  directory.resize(leaf);
  const std::size_t slash = directory.find_last_of(L"\\/");
  if (slash != std::wstring::npos &&
      SameWindowsTargetName(std::wstring_view(directory).substr(slash + 1),
                            L"resources"))
    directory.resize(slash);
  return directory;
}

// The roots in precedence order (the first one a path lies under names it). std::nullopt when the
// self install root was given but cannot be canonicalized: Sprint Coder's own files would then
// pass as an ordinary root. A root that does not exist holds nothing and is left out.
std::optional<std::vector<sprint_coder::computer_use::WindowsImageRootPrefix>>
CurrentWindowsTargetRoots(const std::wstring &self_install_root) {
  using sprint_coder::computer_use::WindowsImageRootPrefix;
  std::vector<WindowsImageRootPrefix> roots;
  if (!self_install_root.empty()) {
    std::string self = CanonicalWindowsTargetDirectory(self_install_root);
    if (self.empty())
      return std::nullopt;
    roots.push_back({"self_install", std::move(self)});
  }
  const auto add = [&roots](std::string_view root, const std::wstring &directory) {
    std::string prefix = CanonicalWindowsTargetDirectory(directory);
    if (!prefix.empty())
      roots.push_back({root, std::move(prefix)});
  };
  const std::string program_files = CanonicalWindowsTargetDirectory(
      WindowsTargetKnownFolder(FOLDERID_ProgramFiles));
  // WindowsApps lists nothing to a user, so its own name is spelled rather than opened.
  if (!program_files.empty())
    roots.push_back({"windows_apps", program_files + "\\WindowsApps"});
  std::vector<wchar_t> windows(32'768, L'\0');
  const UINT windows_length = GetSystemWindowsDirectoryW(
      windows.data(), static_cast<UINT>(windows.size()));
  if (windows_length > 0 && windows_length < windows.size())
    add("windows_directory", std::wstring(windows.data(), windows_length));
  if (!program_files.empty())
    roots.push_back({"program_files", program_files});
  add("program_files", WindowsTargetKnownFolder(FOLDERID_ProgramFilesX86));
  add("local_programs", WindowsTargetKnownFolder(FOLDERID_UserProgramFiles));
  std::vector<wchar_t> temp(32'768, L'\0');
  const DWORD temp_length =
      GetTempPathW(static_cast<DWORD>(temp.size()), temp.data());
  if (temp_length > 0 && temp_length < temp.size())
    add("temp", std::wstring(temp.data(), temp_length));
  add("downloads", WindowsTargetKnownFolder(FOLDERID_Downloads));
  return roots;
}

// Whether a handle's file is on a remote volume (an SMB share and such, which can report a local
// file system name like "NTFS"). The decision is made from the held handle, so it holds through
// UNC, SUBST and mount points, unlike a drive-letter or path-prefix test. The primary is the
// kernel's FileFsDeviceInformation (its Characteristics FILE_REMOTE_DEVICE bit, read with
// NtQueryVolumeInformationFile); FileRemoteProtocolInfo is a supplementary remote signal. Remote
// (true) when either shows remote; local (false) only when the device info is readable and local;
// std::nullopt (unknown, treated as W-UR) when the device info cannot be read.
std::optional<bool> WindowsTargetFileIsRemote(HANDLE file) {
  // IO_STATUS_BLOCK is in <winternl.h>, which this TU does not include; its x64 layout is two
  // pointer-sized words, pinned here as the one is for SECTION_IMAGE_INFORMATION.
  struct IoStatusBlock {
    PVOID pointer;
    ULONG_PTR information;
  };
  using NtQueryVolumeInformationFileFn =
      LONG(WINAPI *)(HANDLE, IoStatusBlock *, PVOID, ULONG, int);
  static const NtQueryVolumeInformationFileFn query = []() {
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    return ntdll == nullptr ? nullptr
                            : reinterpret_cast<NtQueryVolumeInformationFileFn>(
                                  GetProcAddress(ntdll, "NtQueryVolumeInformationFile"));
  }();
  if (query == nullptr)
    return std::nullopt;
  struct FileFsDeviceInformation {
    ULONG device_type;
    ULONG characteristics;
  };
  constexpr int kFileFsDeviceInformation = 4;
  constexpr ULONG kFileRemoteDevice = 0x10; // FILE_REMOTE_DEVICE
  FileFsDeviceInformation device{};
  IoStatusBlock status{};
  if (query(file, &status, &device, sizeof(device), kFileFsDeviceInformation) < 0)
    return std::nullopt;
  if ((device.characteristics & kFileRemoteDevice) != 0)
    return true;
  FILE_REMOTE_PROTOCOL_INFO remote{};
  if (GetFileInformationByHandleEx(file, FileRemoteProtocolInfo, &remote, sizeof(remote)))
    return true;
  return false;
}

// The volume (file system name lower-cased, and FileSystemFlags) of a handle's file, or
// std::nullopt. A remote or unknown-remoteness volume is std::nullopt whatever name it reports.
std::optional<WindowsTargetVolume> WindowsTargetReadVolume(HANDLE file) {
  if (WindowsTargetFileIsRemote(file) != std::optional<bool>(false))
    return std::nullopt;
  std::array<wchar_t, MAX_PATH + 1> name{};
  DWORD flags = 0;
  if (GetVolumeInformationByHandleW(file, nullptr, 0, nullptr, nullptr, &flags, name.data(),
                                    static_cast<DWORD>(name.size())) != TRUE)
    return std::nullopt;
  std::string lowered = Utf8FromWide(name.data());
  for (char &letter : lowered)
    if (letter >= 'A' && letter <= 'Z') letter = static_cast<char>(letter - 'A' + 'a');
  return WindowsTargetVolume{std::move(lowered), flags};
}

// Whether a file system's 128-bit file id is dependable: NTFS or ReFS.
bool WindowsTargetFileSystemHasStableId(std::string_view file_system) {
  return file_system == "ntfs" || file_system == "refs";
}

// Opens a Win32 path read-only (sharing everything, so a running image can be opened) and returns
// its canonical path and file identity, or std::nullopt when it cannot be opened or read.
struct WindowsPathIdentity {
  std::wstring canonical_path;
  WindowsFileIdentity identity;
};
std::optional<WindowsPathIdentity> WindowsTargetOpenPathIdentity(const std::wstring &path) {
  ScopedKernelHandle file(CreateFileW(
      path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL, nullptr));
  WindowsPathIdentity result;
  if (file.value == INVALID_HANDLE_VALUE ||
      !ReadWindowsFileIdentity(file.value, &result.identity) ||
      !CanonicalWindowsPathFromHandle(file.value, &result.canonical_path))
    return std::nullopt;
  return result;
}

// Measures, once, whether QueryFullProcessImageNameW follows a rename of a running image. A copy of
// this helper's own exe is started SUSPENDED (so it never runs a single instruction: no behaviour,
// no pipe, no window), its kernel image name is read, the file is renamed within its directory and
// then moved to another directory on the same volume, and the name is read after each; it follows
// only when both moves are followed. The child is held in a job that kills it on close and the temp
// files are deleted. std::nullopt when the probe could not run (copy, launch, rename or move
// failed, or the temp file system is unknown or remote), which the caller treats as fail closed.
// The probe runs on the temp volume, so its result speaks only for that volume's file system.
std::optional<WindowsTargetRenameProbe> WindowsTargetRenameFollows(
    const std::function<bool()> &still_valid = {}) {
  const auto active = [&] { return !still_valid || still_valid(); };
  if (!active()) return std::nullopt;
  std::vector<wchar_t> module(32'768, L'\0');
  const DWORD module_length =
      GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
  std::vector<wchar_t> temp(32'768, L'\0');
  DWORD temp_length = GetEnvironmentVariableW(L"SPRINT_CODER_COMPUTER_USE_HELPER_TEMP",
                                               temp.data(), static_cast<DWORD>(temp.size()));
  const auto separator = [](wchar_t letter) { return letter == L'\\' || letter == L'/'; };
  const bool absolute = temp_length > 0 && temp_length < temp.size() &&
      ((temp_length >= 3 &&
        ((temp[0] >= L'A' && temp[0] <= L'Z') || (temp[0] >= L'a' && temp[0] <= L'z')) &&
        temp[1] == L':' && separator(temp[2])) ||
       (temp_length >= 2 && separator(temp[0]) && separator(temp[1])));
  const DWORD attributes = absolute ? GetFileAttributesW(temp.data()) : INVALID_FILE_ATTRIBUTES;
  const bool main_managed_temp = attributes != INVALID_FILE_ATTRIBUTES &&
      (attributes & FILE_ATTRIBUTE_DIRECTORY);
  if (!main_managed_temp)
    temp_length = GetTempPathW(static_cast<DWORD>(temp.size()), temp.data());
  if (module_length == 0 || module_length >= module.size() || temp_length == 0 ||
      temp_length >= temp.size())
    return std::nullopt;
  std::wstring directory(temp.data(), temp_length);
  if (!separator(directory.back())) directory += L'\\';
  const std::wstring stem = directory + L"sc-rename-probe-" +
                            std::to_wstring(GetCurrentProcessId()) + L"-" +
                            std::to_wstring(GetTickCount64());
  // A subdirectory on the same volume, for the cross-directory move.
  const std::wstring subdirectory = stem + L"-dir";
  const std::wstring first = stem + L"-a.exe";
  const std::wstring second = stem + L"-b.exe";
  const std::wstring third = subdirectory + L"\\c.exe";
  ScopedKernelHandle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
  std::optional<WindowsTargetRenameProbe> result;
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
                                             &limits, sizeof(limits))) return std::nullopt;
  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  if (attribute_bytes == 0) return std::nullopt;
  std::vector<unsigned char> attribute_storage(attribute_bytes);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_bytes))
    return std::nullopt;
  struct AttributeList {
    LPPROC_THREAD_ATTRIBUTE_LIST value;
    ~AttributeList() { DeleteProcThreadAttributeList(value); }
  } attribute_list{startup.lpAttributeList};
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                 &job.value, sizeof(job.value), nullptr, nullptr)) return std::nullopt;
  PROCESS_INFORMATION process{};
  ScopedKernelHandle child_process, child_thread;
  std::wstring command = L"\"" + first + L"\"";
  if (!active() || CopyFileW(std::wstring(module.data(), module_length).c_str(), first.c_str(), TRUE) != TRUE)
    return std::nullopt;
  if (active()) CreateDirectoryW(subdirectory.c_str(), nullptr);
  if (active() &&
      CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
                     CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                     nullptr, nullptr, &startup.StartupInfo,
                     &process)) {
    child_process.value = process.hProcess;
    child_thread.value = process.hThread;
    // The probe volume and the copied file's identity, read from the copied file itself.
    std::optional<WindowsTargetVolume> probe_volume;
    std::optional<WindowsFileIdentity> probe_id;
    if (active()) {
      ScopedKernelHandle probe_handle(CreateFileW(first.c_str(), FILE_READ_ATTRIBUTES,
                                                  FILE_SHARE_READ | FILE_SHARE_WRITE |
                                                      FILE_SHARE_DELETE,
                                                  nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                                                  nullptr));
      WindowsFileIdentity identity;
      if (probe_handle.value != INVALID_HANDLE_VALUE) {
        probe_volume = WindowsTargetReadVolume(probe_handle.value);
        if (ReadWindowsFileIdentity(probe_handle.value, &identity))
          probe_id = identity;
      }
    }
    // A freshly copied exe can be held briefly by another reader (an anti-virus scan, say), which
    // fails the move with a sharing violation; retry for up to about a second before giving up.
    const auto move = [&](const std::wstring &from, const std::wstring &to) {
      for (int attempt = 0; attempt < 20; ++attempt) {
        if (!active()) return false;
        if (MoveFileExW(from.c_str(), to.c_str(), 0) == TRUE)
          return true;
        const DWORD error = GetLastError();
        if (error != ERROR_SHARING_VIOLATION && error != ERROR_ACCESS_DENIED)
          return false;
        Sleep(50);
      }
      return false;
    };
    // The kernel image name, opened and normalized the same way as the expected location, names the
    // same file (so a TEMP reached through a junction, SUBST or an 8.3 short name still matches).
    const auto names_the_file = [&](const std::wstring &expected) {
      if (!active()) return false;
      std::wstring reported;
      if (!ReadProcessPath(process.hProcess, &reported) || !active()) return false;
      const std::optional<WindowsPathIdentity> from_kernel =
          WindowsTargetOpenPathIdentity(reported);
      if (!active()) return false;
      const std::optional<WindowsPathIdentity> from_expected =
          WindowsTargetOpenPathIdentity(expected);
      return from_kernel.has_value() && from_expected.has_value() && probe_id.has_value() &&
             SameWindowsTargetName(from_kernel->canonical_path, from_expected->canonical_path) &&
             SameWindowsFileIdentity(from_kernel->identity, *probe_id) &&
             SameWindowsFileIdentity(from_expected->identity, *probe_id);
    };
    if (active() && probe_volume.has_value() && probe_id.has_value()) {
      const bool at_first = names_the_file(first);
      const bool at_second = move(first, second) && names_the_file(second);
      const bool at_third = at_second && move(second, third) && names_the_file(third);
      WindowsTargetRenameProbe probe;
      probe.follows = at_first && at_second && at_third;
      probe.volume = *probe_volume;
      if (active()) result = probe;
    }
    TerminateJobObject(job.value, 0);
    const ULONGLONG deadline = GetTickCount64() + 2'000;
    bool exited = false;
    do {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if (QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation,
                                    &accounting, sizeof(accounting), nullptr) &&
          accounting.ActiveProcesses == 0) {
        exited = true;
        break;
      }
      Sleep(10);
    } while (GetTickCount64() < deadline);
    // Only Main's directory has a later cleanup owner; fallback files need a best-effort cleanup.
    if (main_managed_temp) {
      if (!exited) return std::nullopt;
    } else if (!exited) {
      result.reset();
    }
    CloseHandle(child_thread.release());
    CloseHandle(child_process.release());
  }
  CloseHandle(job.release());
  // Normally exit is confirmed. On a fallback timeout, closing the job also requests termination;
  // retry deletion while the kernel finishes tearing the image mapping down.
  for (const std::wstring &file : {first, second, third})
    for (int attempt = 0; attempt < 20 && GetFileAttributesW(file.c_str()) != INVALID_FILE_ATTRIBUTES;
         ++attempt)
      if (DeleteFileW(file.c_str()) != TRUE)
        Sleep(50);
  RemoveDirectoryW(subdirectory.c_str());
  return result;
}

// The context of a measurement made by this helper: the roots with Sprint Coder's install root,
// and the lineage root for W8 ("Sprint Coder's own"). The lineage root is the Main process (the
// Electron app that ServeMain's parent check verified), not this helper: Main and all its
// descendants, this helper and the agent's child processes among them, are Sprint Coder's own, and
// the root itself counts, so a development-mode Main image (electron.exe) is W8 too. `main_pid` is
// 0 only when it cannot be opened, which leaves the lineage unmeasured (own_descendant stays
// unset, so the target is unresolvable rather than wrongly not-own).
WindowsTargetFactsContext CurrentWindowsTargetFactsContext(std::uint32_t main_pid,
                                                           std::string self_signer_thumbprint,
                                                           const std::function<bool()> &still_valid = {}) {
  WindowsTargetFactsContext context;
  if (still_valid && !still_valid()) return context;
  context.roots = CurrentWindowsTargetRoots(WindowsTargetSelfInstallRoot());
  if (still_valid && !still_valid()) return WindowsTargetFactsContext{};
  ScopedKernelHandle main(
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, main_pid));
  const std::optional<std::uint64_t> creation =
      main.value == nullptr ? std::nullopt : WindowsTargetCreationTime(main.value);
  if (main_pid != 0 && creation.has_value() &&
      GetProcessId(main.value) == main_pid) {
    context.lineage_root_pid = main_pid;
    context.lineage_root_creation = *creation;
  }
  context.self_signer_thumbprint = std::move(self_signer_thumbprint);
  if (still_valid && !still_valid()) return WindowsTargetFactsContext{};
  context.rename_probe = WindowsTargetRenameFollows(still_valid);
  return context;
}

// The device-form name of the file mapped at `address` in `process`, or std::nullopt.
std::optional<std::wstring> WindowsTargetMappedFileName(HANDLE process, LPVOID address) {
  std::vector<wchar_t> name(32'768, L'\0');
  const DWORD length = GetMappedFileNameW(process, address, name.data(),
                                          static_cast<DWORD>(name.size()));
  if (length == 0 || length >= name.size())
    return std::nullopt;
  return std::wstring(name.data(), length);
}

// The main image from kernel-held data, not from the target's module list (the PEB Ldr list is
// writable by the target, so its first entry can be made to name another file). The kernel records
// the image's entry point and header summary in SECTION_IMAGE_INFORMATION; the entry point lies in
// the main image's MEM_IMAGE mapping, whose backing file GetMappedFileNameW returns, and the header
// values are later matched against the held file's PE header, since the target can remap another
// file at that address but cannot change what the kernel captured at creation.
struct WindowsTargetKernelImage {
  std::wstring mapped_name;
  bool il_only_anchor = false;
  // The entry point as a file RVA (TransferAddress - the mapping's allocation base, both from the
  // kernel: TransferAddress from SECTION_IMAGE_INFORMATION and the base from VirtualQueryEx's VAD,
  // not from the PEB), and the header values the kernel captured from the real image at creation.
  // These are an auxiliary deny-side cross-check; the running image's identity is anchored by the
  // post-hold re-read of the kernel image name (see HoldWindowsTargetRunningImage).
  std::uint32_t entry_rva = 0;
  std::uint16_t subsystem = 0;
  std::uint16_t machine = 0;
  std::uint32_t check_sum = 0;
  std::uint32_t image_file_size = 0;
  std::uint16_t image_characteristics = 0;
  std::uint16_t dll_characteristics = 0;
  std::uint64_t stack_reserve = 0;
  std::uint64_t stack_commit = 0;
};

// P5 enables this together with the eligibility/ruleset change. Early opt-in requires an explicit
// acceptance value of 1; the test switch is forbidden in production build inputs.
#if defined(SPRINT_CODER_TEST_IL_ONLY_IMAGE_ANCHOR) && (defined(SPRINT_CODER_ELIGIBILITY_FROM_BUILD) || defined(SPRINT_CODER_REQUIRE_WINDOWS_GRAPHICS_CAPTURE))
#error IL-only image anchor test switch must not be used in production builds
#endif
// The final declaration alone does not enable the IL-only anchor.
inline constexpr bool kWindowsIlOnlyImageAnchorReady = false;
#if defined(SPRINT_CODER_TEST_IL_ONLY_IMAGE_ANCHOR) && SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD == 1
inline constexpr bool kWindowsIlOnlyImageAnchor =
    true || sprint_coder::computer_use::kNativeEligibilityWindowsV2Final;
#else
inline constexpr bool kWindowsIlOnlyImageAnchor =
    sprint_coder::computer_use::kNativeEligibilityWindowsV2Final &&
    kWindowsIlOnlyImageAnchorReady;
#endif

struct WindowsIlOnlyImageHeader {
  std::uint32_t magic = 0;
  std::uint32_t machine = 0;
  std::uint32_t entry_rva = 0;
  std::uint32_t image_size = 0;
  std::uint32_t timestamp = 0;
  std::uint32_t check_sum = 0;
  std::uint64_t image_base = 0;
};

std::optional<WindowsIlOnlyImageHeader>
WindowsReadIlOnlyImageHeader(std::span<const std::uint8_t> bytes) {
  using namespace sprint_coder::computer_use::windows_target_facts_detail;
  if (!sprint_coder::computer_use::ParsePeImageSummary(bytes).has_value()) return std::nullopt;
  const auto pe = ReadLe(bytes, 0x3c, 4);
  if (!pe.has_value()) return std::nullopt;
  const auto optional = OffsetWithin(*pe, 24, bytes.size());
  if (!optional.has_value()) return std::nullopt;
  const auto magic = ReadLe(bytes, *optional, 2);
  const auto machine = ReadLe(bytes, *pe + 4, 2);
  const auto entry = ReadLe(bytes, *optional + 16, 4);
  const auto size = ReadLe(bytes, *optional + 56, 4);
  const auto timestamp = ReadLe(bytes, *pe + 8, 4);
  const auto checksum = ReadLe(bytes, *optional + 64, 4);
  const bool wide = magic == std::optional<std::uint32_t>(0x20b);
  const auto base_low = ReadLe(bytes, *optional + (wide ? 24 : 28), 4);
  const auto base_high = wide ? ReadLe(bytes, *optional + 28, 4)
                              : std::optional<std::uint32_t>(0);
  if (!magic || !machine || !entry || !size || !timestamp || !checksum || !base_low || !base_high ||
      *size == 0 || *entry >= *size)
    return std::nullopt;
  return WindowsIlOnlyImageHeader{*magic, *machine, *entry, *size, *timestamp, *checksum,
                                  *base_low | (static_cast<std::uint64_t>(*base_high) << 32)};
}

bool WindowsIlOnlyHeadersMatch(const WindowsIlOnlyImageHeader &file,
                              const WindowsIlOnlyImageHeader &mapped,
                              std::optional<std::uint32_t> clr_flags,
                              std::optional<bool> native64) {
  // ImageBase is a preferred address, not an identity field of a relocated mapping.
  // The loader may widen an IL-only PE32 header in a native 64-bit process. Only magic may differ;
  // the mapped header is parsed using its own layout, and the post-hold identity anchor is unchanged.
  const bool converted = native64 == std::optional<bool>(true) && clr_flags &&
      (*clr_flags & 1) != 0 && (*clr_flags & 2) == 0 &&
      file.magic == 0x10b && file.machine == 0x14c && mapped.magic == 0x20b;
  return (file.magic == mapped.magic || converted) && file.machine == mapped.machine &&
         file.entry_rva == mapped.entry_rva && file.image_size == mapped.image_size &&
         file.timestamp == mapped.timestamp && file.check_sum == mapped.check_sum;
}

std::optional<WindowsIlOnlyImageHeader> WindowsReadMappedIlOnlyHeader(HANDLE process, LPVOID base) {
  constexpr std::size_t kHeaderLimit = 64 * 1024;
  IMAGE_DOS_HEADER dos{};
  SIZE_T read = 0;
  if (!ReadProcessMemory(process, base, &dos, sizeof(dos), &read) || read != sizeof(dos) ||
      dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew < static_cast<LONG>(sizeof(dos)) ||
      static_cast<std::size_t>(dos.e_lfanew) > kHeaderLimit - 24)
    return std::nullopt;
  const auto address = reinterpret_cast<std::uintptr_t>(base);
  if (address > UINTPTR_MAX - kHeaderLimit) return std::nullopt;
  std::array<std::uint8_t, 24> nt{};
  if (!ReadProcessMemory(process, reinterpret_cast<LPCVOID>(address + dos.e_lfanew),
                         nt.data(), nt.size(), &read) || read != nt.size())
    return std::nullopt;
  const auto optional_size = sprint_coder::computer_use::windows_target_facts_detail::ReadLe(nt, 20, 2);
  if (!optional_size || *optional_size > kHeaderLimit - dos.e_lfanew - nt.size())
    return std::nullopt;
  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(dos.e_lfanew) + nt.size() + *optional_size);
  if (!ReadProcessMemory(process, base, bytes.data(), bytes.size(), &read) || read != bytes.size())
    return std::nullopt;
  return WindowsReadIlOnlyImageHeader(bytes);
}

struct WindowsIlOnlyImageMapping {
  std::wstring name;
  std::uint32_t entry_rva = 0;
};

std::optional<std::uint32_t> WindowsHeldImageClrFlags(std::span<const std::uint8_t> bytes) {
  using namespace sprint_coder::computer_use::windows_target_facts_detail;
  // The shared summary validates the PE, but its CLR bitness-conversion flag excludes x64 and
  // 32BITPREFERRED. Read ILONLY independently from the held file's bounded CLR directory.
  if (!sprint_coder::computer_use::ParsePeImageSummary(bytes)) return std::nullopt;
  const auto pe = ReadLe(bytes, 0x3c, 4);
  if (!pe) return std::nullopt;
  const auto optional = OffsetWithin(*pe, 24, bytes.size());
  const auto optional_size = ReadLe(bytes, *pe + 20, 2);
  const auto sections = ReadLe(bytes, *pe + 6, 2);
  if (!optional || !optional_size || !sections) return std::nullopt;
  const bool wide = ReadLe(bytes, *optional, 2) == std::optional<std::uint32_t>(0x20b);
  const std::size_t directory = (wide ? 112 : 96) + 14 * 8;
  const auto count = ReadLe(bytes, *optional + (wide ? 108 : 92), 4);
  if (*optional_size < directory + 8 || !count || *count < 15) return std::nullopt;
  const auto rva = ReadLe(bytes, *optional + directory, 4);
  const auto size = ReadLe(bytes, *optional + directory + 4, 4);
  const auto table = OffsetWithin(*optional, *optional_size, bytes.size());
  if (!rva || *rva == 0 || !size || *size < 72 || !table) return std::nullopt;
  std::optional<std::size_t> clr;
  for (std::size_t index = 0; index < *sections; ++index) {
    const auto end = OffsetWithin(*table, index * 40 + 40, bytes.size());
    if (!end) return std::nullopt;
    const auto at = *end - 40;
    const auto address = ReadLe(bytes, at + 12, 4);
    const auto raw_size = ReadLe(bytes, at + 16, 4);
    const auto raw = ReadLe(bytes, at + 20, 4);
    if (!address || !raw_size || !raw) return std::nullopt;
    if (*rva < *address || *rva - *address >= *raw_size) continue;
    const auto delta = *rva - *address;
    if (clr || *raw_size - delta < 72) return std::nullopt;
    clr = OffsetWithin(*raw, delta, bytes.size());
    if (!clr || !OffsetWithin(*clr, 72, bytes.size())) return std::nullopt;
  }
  if (!clr) return std::nullopt;
  const auto cb = ReadLe(bytes, *clr, 4);
  const auto flags = ReadLe(bytes, *clr + 16, 4);
  if (!cb || *cb < 72 || *cb > *size || !flags) return std::nullopt;
  return flags;
}

bool WindowsHeldImageIsIlOnly(std::span<const std::uint8_t> bytes) {
  const auto flags = WindowsHeldImageClrFlags(bytes);
  return flags && (*flags & 1) != 0;
}

std::optional<bool> WindowsTargetIsNative64Bit(HANDLE process) {
  using QueryFn = BOOL (WINAPI *)(HANDLE, USHORT *, USHORT *);
  static const auto query = reinterpret_cast<QueryFn>(
      GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "IsWow64Process2"));
  USHORT process_machine = 0, native_machine = 0;
  if (query == nullptr || !query(process, &process_machine, &native_machine)) return std::nullopt;
  return process_machine == IMAGE_FILE_MACHINE_UNKNOWN &&
      (native_machine == IMAGE_FILE_MACHINE_AMD64 || native_machine == IMAGE_FILE_MACHINE_ARM64);
}

std::optional<WindowsIlOnlyImageMapping>
WindowsTargetIlOnlyImageMapping(HANDLE process, LPVOID transfer, HANDLE held_file) {
  // All I/O stays on the measuring thread, including while WindowsNewStartIoRegistration is
  // active: CancelSynchronousIo failures propagate as no answer. The caller's existing deadline
  // and adoption guards still apply; bound the additional address-space walk independently too.
  constexpr unsigned kRegionLimit = 65'536;
  constexpr ULONGLONG kScanBudgetMs = 250;
  const ULONGLONG started = GetTickCount64();
  const auto within_budget = [&] { return GetTickCount64() - started < kScanBudgetMs; };
  std::vector<wchar_t> name(32'768, L'\0');
  DWORD length = static_cast<DWORD>(name.size());
  if (!QueryFullProcessImageNameW(process, PROCESS_NAME_NATIVE, name.data(), &length) ||
      length == 0 || length >= name.size())
    return std::nullopt;
  const std::wstring kernel_name(name.data(), length);
  const auto utf8 = WindowsTargetUtf8(kernel_name);
  if (!utf8 || sprint_coder::computer_use::WindowsNativeImageIsRemote(*utf8) || !within_budget())
    return std::nullopt;
  // The first measurement precedes the main hold; retain a no-write/no-delete handle while
  // matching. The post-hold remeasurement below uses the caller's actual held file instead.
  ScopedKernelHandle opened;
  if (held_file == nullptr) {
    const std::wstring global = L"\\\\?\\GLOBALROOT" + kernel_name;
    opened.value = CreateFileW(global.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (opened.value == INVALID_HANDLE_VALUE) { opened.value = nullptr; return std::nullopt; }
    held_file = opened.value;
  }
  std::vector<std::uint8_t> bytes(64 * 1024);
  OVERLAPPED at{};
  DWORD read = 0;
  if (!within_budget() || !ReadFile(held_file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, &at))
    return std::nullopt;
  bytes.resize(read);
  if (!WindowsHeldImageIsIlOnly(bytes)) return std::nullopt;
  const auto header = WindowsReadIlOnlyImageHeader(bytes);
  const auto entry = reinterpret_cast<std::uintptr_t>(transfer);
  if (!header || entry < header->image_base || entry - header->image_base != header->entry_rva)
    return std::nullopt;

  SYSTEM_INFO system{};
  GetNativeSystemInfo(&system);
  const auto maximum = reinterpret_cast<std::uintptr_t>(system.lpMaximumApplicationAddress);
  std::uintptr_t cursor = 0;
  LPVOID previous_allocation = nullptr;
  LPVOID matched = nullptr;
  bool complete = false;
  for (unsigned count = 0; count < kRegionLimit && within_budget(); ++count) {
    MEMORY_BASIC_INFORMATION region{};
    if (VirtualQueryEx(process, reinterpret_cast<LPCVOID>(cursor), &region, sizeof(region)) !=
        sizeof(region))
      return std::nullopt;
    if (region.Type == MEM_IMAGE && region.AllocationBase != previous_allocation) {
      if (region.AllocationBase == nullptr) return std::nullopt;
      previous_allocation = region.AllocationBase;
      const auto mapped = WindowsTargetMappedFileName(process, region.AllocationBase);
      // An unreadable allocation could be a second match, so it cannot be ignored.
      if (!mapped) return std::nullopt;
      if (SameWindowsTargetName(*mapped, kernel_name)) {
        if (matched != nullptr) return std::nullopt;
        matched = region.AllocationBase;
      }
    }
    const auto base = reinterpret_cast<std::uintptr_t>(region.BaseAddress);
    if (region.RegionSize == 0 || base > UINTPTR_MAX - region.RegionSize) return std::nullopt;
    const auto next = base + region.RegionSize;
    if (next <= cursor) return std::nullopt;
    if (next > maximum) { complete = true; break; }
    cursor = next;
  }
  if (!complete || matched == nullptr || !within_budget()) return std::nullopt;
  const auto mapped_header = WindowsReadMappedIlOnlyHeader(process, matched);
  const auto native64 = WindowsTargetIsNative64Bit(process);
  const auto clr_flags = WindowsHeldImageClrFlags(bytes);
  if (!mapped_header || !WindowsIlOnlyHeadersMatch(*header, *mapped_header, clr_flags, native64) || !within_budget())
    return std::nullopt;
  return WindowsIlOnlyImageMapping{kernel_name, header->entry_rva};
}

// TransferAddress can land in MEM_IMAGE even for IL-only executables. The disabled
// gate must inspect the kernel-named file, not infer its CLR kind from address placement.
bool WindowsTargetImageAllowsDisabledIlOnlyAnchor(HANDLE process, HANDLE held_file) {
  ScopedKernelHandle opened;
  if (held_file == nullptr) {
    std::vector<wchar_t> name(32'768, L'\0');
    DWORD length = static_cast<DWORD>(name.size());
    if (!QueryFullProcessImageNameW(process, PROCESS_NAME_NATIVE, name.data(), &length) ||
        length == 0 || length >= name.size())
      return false;
    const std::wstring kernel_name(name.data(), length);
    const auto utf8 = WindowsTargetUtf8(kernel_name);
    if (!utf8 || sprint_coder::computer_use::WindowsNativeImageIsRemote(*utf8)) return false;
    const std::wstring global = L"\\\\?\\GLOBALROOT" + kernel_name;
    opened.value = CreateFileW(global.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (opened.value == INVALID_HANDLE_VALUE) { opened.value = nullptr; return false; }
    held_file = opened.value;
  }
  std::vector<std::uint8_t> bytes(64 * 1024);
  OVERLAPPED at{};
  DWORD read = 0;
  if (!ReadFile(held_file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, &at)) return false;
  bytes.resize(read);
  using namespace sprint_coder::computer_use::windows_target_facts_detail;
  if (!sprint_coder::computer_use::ParsePeImageSummary(bytes)) return false;
  const auto pe = ReadLe(bytes, 0x3c, 4);
  if (!pe) return false;
  const auto optional = OffsetWithin(*pe, 24, bytes.size());
  if (!optional) return false;
  const bool wide = ReadLe(bytes, *optional, 2) == std::optional<std::uint32_t>(0x20b);
  const auto optional_size = ReadLe(bytes, *pe + 20, 2);
  if (!optional_size || *optional_size < (wide ? 112u : 96u)) return false;
  const auto count = ReadLe(bytes, *optional + (wide ? 108 : 92), 4);
  if (!count) return false;
  if (*count < 15) return true;
  if (*optional_size < (wide ? 112u : 96u) + 15 * 8) return false;
  const auto clr_rva = ReadLe(bytes, *optional + (wide ? 112 : 96) + 14 * 8, 4);
  if (!clr_rva) return false;
  if (*clr_rva == 0) return true;
  // A present but unreadable CLR directory cannot establish that ILONLY is off.
  const auto flags = WindowsHeldImageClrFlags(bytes);
  return flags && (*flags & 1) == 0;
}

std::optional<WindowsTargetKernelImage> WindowsTargetKernelImageInfo(HANDLE process,
                                                                   HANDLE held_file = nullptr) {
  if constexpr (!kWindowsIlOnlyImageAnchor) {
    if (!WindowsTargetImageAllowsDisabledIlOnlyAnchor(process, held_file)) return std::nullopt;
  }
  using NtQueryInformationProcessFn =
      LONG(WINAPI *)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  static const NtQueryInformationProcessFn query = []() {
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    return ntdll == nullptr
               ? nullptr
               : reinterpret_cast<NtQueryInformationProcessFn>(
                     GetProcAddress(ntdll, "NtQueryInformationProcess"));
  }();
  if (query == nullptr)
    return std::nullopt;
  // SECTION_IMAGE_INFORMATION, whose x64 layout is pinned so the whole structure can be supplied.
  struct SectionImageInformation {
    PVOID transfer_address;
    ULONG zero_bits;
    SIZE_T maximum_stack_size;
    SIZE_T committed_stack_size;
    ULONG sub_system_type;
    ULONG sub_system_version;
    ULONG operating_system_version;
    USHORT image_characteristics;
    USHORT dll_characteristics;
    USHORT machine;
    UCHAR image_contains_code;
    UCHAR image_flags;
    ULONG loader_flags;
    ULONG image_file_size;
    ULONG check_sum;
  };
  static_assert(sizeof(SectionImageInformation) == 64,
                "SECTION_IMAGE_INFORMATION must match the kernel's x64 layout");
  constexpr ULONG kProcessImageInformation = 37;
  SectionImageInformation image{};
  ULONG returned = 0;
  if (query(process, kProcessImageInformation, &image, sizeof(image), &returned) < 0 ||
      image.transfer_address == nullptr)
    return std::nullopt;
  // Native entry points name their mapping directly. The alternative remains disabled until P5.
  MEMORY_BASIC_INFORMATION region{};
  if (VirtualQueryEx(process, image.transfer_address, &region, sizeof(region)) !=
          sizeof(region))
    return std::nullopt;
  WindowsTargetKernelImage info;
  if (region.Type != MEM_IMAGE) {
    if constexpr (!kWindowsIlOnlyImageAnchor) {
      return std::nullopt;
    } else {
      const auto mapping = WindowsTargetIlOnlyImageMapping(process, image.transfer_address, held_file);
      if (!mapping) return std::nullopt;
      info.il_only_anchor = true;
      info.mapped_name = mapping->name;
      info.entry_rva = mapping->entry_rva;
    }
  } else {
    if (region.AllocationBase == nullptr || image.transfer_address < region.AllocationBase)
      return std::nullopt;
    const std::optional<std::wstring> mapped =
        WindowsTargetMappedFileName(process, region.AllocationBase);
    if (!mapped.has_value()) return std::nullopt;
    info.mapped_name = *mapped;
    info.entry_rva = static_cast<std::uint32_t>(
        reinterpret_cast<std::uintptr_t>(image.transfer_address) -
        reinterpret_cast<std::uintptr_t>(region.AllocationBase));
  }
  info.subsystem = static_cast<std::uint16_t>(image.sub_system_type);
  info.machine = image.machine;
  info.check_sum = image.check_sum;
  info.image_file_size = image.image_file_size;
  info.image_characteristics = image.image_characteristics;
  info.dll_characteristics = image.dll_characteristics;
  info.stack_reserve = static_cast<std::uint64_t>(image.maximum_stack_size);
  info.stack_commit = static_cast<std::uint64_t>(image.committed_stack_size);
  return info;
}

std::optional<std::wstring> WindowsTargetKernelImageName(HANDLE process) {
  const std::optional<WindowsTargetKernelImage> info = WindowsTargetKernelImageInfo(process);
  return info.has_value() ? std::optional<std::wstring>(info->mapped_name) : std::nullopt;
}

// An auxiliary deny-side check: whether a held file's PE header disagrees with what the kernel
// recorded for the process at creation. A field is compared only when both sides carry it, so a
// field the header does not cover never refuses on its own; a field that is present and differs
// does. This is not the anchor (the kernel can be fooled on checksum, which Authenticode does not
// cover, and an attacker who builds the original can match the rest); the anchor is the post-hold
// name re-read. False means a disagreement was found.
bool WindowsHeldImageDisagreesWithKernel(HANDLE file, const WindowsTargetKernelImage &kernel) {
  std::vector<std::uint8_t> header(64 * 1024);
  OVERLAPPED at{};
  DWORD read = 0;
  if (ReadFile(file, header.data(), static_cast<DWORD>(header.size()), &read, &at) != TRUE)
    return true;
  header.resize(read);
  const std::optional<sprint_coder::computer_use::PeImageSummary> summary =
      sprint_coder::computer_use::ParsePeImageSummary(header);
  if (!summary.has_value() || summary->subsystem_code != kernel.subsystem)
    return true;
  // No field is skipped for an IL-only (.NET) image (S5-c-3 PR-5, measured on Windows 11 26200). PR-2
  // skipped the fields of a PE32 AnyCPU image on the expectation that the loader's PE32 -> PE32+
  // conversion shows in SECTION_IMAGE_INFORMATION. It does not: for a PE32 AnyCPU image (AddInUtil,
  // EdmGen, dfsvc, and a csc /platform:anycpu build), a 32BITPREFERRED one and a PE32+ IL-only one
  // (Framework64 InstallUtil, csc /platform:x64), suspended and running, every header value the kernel
  // records equals the file's (machine 0x14c stays 0x14c). TransferAddress was outside MEM_IMAGE
  // in those measurements, but that placement is not guaranteed. The disabled gate now checks
  // the file's CLR flags independently of placement. Keeping the skip would only relax the check
  // for an image whose kernel record differs from its header, which no measured image does.
  if (summary->entry_rva != kernel.entry_rva || summary->machine != kernel.machine ||
      summary->check_sum != kernel.check_sum)
    return true;
  if (summary->image_characteristics.has_value() &&
      *summary->image_characteristics != kernel.image_characteristics)
    return true;
  if (summary->dll_characteristics.has_value() &&
      *summary->dll_characteristics != kernel.dll_characteristics)
    return true;
  if (summary->stack_reserve.has_value() && *summary->stack_reserve != kernel.stack_reserve)
    return true;
  if (summary->stack_commit.has_value() && *summary->stack_commit != kernel.stack_commit)
    return true;
  // ImageFileSize is the size of the image file; compare it with the held file's actual size.
  LARGE_INTEGER size{};
  if (kernel.image_file_size != 0 && GetFileSizeEx(file, &size) == TRUE &&
      static_cast<std::uint64_t>(size.QuadPart) != kernel.image_file_size)
    return true;
  return false;
}

// The first module of the target's own list (PEB Ldr). Used only as a deny-side cross-check: it is
// writable by the target, so it can only add a reason to refuse, never remove one.
std::optional<std::wstring> WindowsTargetModuleListImageName(HANDLE process) {
  HMODULE image = nullptr;
  DWORD needed = 0;
  if (EnumProcessModulesEx(process, &image, sizeof(image), &needed,
                           LIST_MODULES_DEFAULT) != TRUE ||
      image == nullptr)
    return std::nullopt;
  return WindowsTargetMappedFileName(process, image);
}

struct WindowsTargetHeldImage {
  ScopedKernelHandle file;
  std::wstring canonical_path;
  WindowsFileIdentity identity;
  bool matches = false;
  bool il_only_anchor = false;
  // Whether the held file was neither written nor had its metadata changed since the process was
  // created (WindowsImageUnchangedSinceCreation); part of `matches`, kept apart for the seam.
  bool unchanged = false;
  // The held file's volume (file system name and flags), for the caller to compare with the rename
  // probe's; std::nullopt when the volume is remote or could not be read.
  std::optional<WindowsTargetVolume> volume;
  // Whether the held file is on a remote volume (std::nullopt: unknown).
  std::optional<bool> remote;
};

// Whether the running image may be said to match: the hold matched, the held file is known not to
// be remote, and the one-time rename probe followed on a volume whose file system name and flags
// are the same as the held file's. Pure, so the seam can drive each input (a remote or unknown
// volume, a probe on another file system or with different flags, a probe that did not follow)
// without a real SMB share. Anything missing is false.
bool WindowsTargetRunningImageMatches(bool held_matches, std::optional<bool> remote,
                                      const std::optional<WindowsTargetVolume> &volume,
                                      const std::optional<WindowsTargetRenameProbe> &probe) {
  return held_matches && remote == std::optional<bool>(false) && probe.has_value() &&
         probe->follows && volume.has_value() &&
         volume->file_system == probe->volume.file_system && volume->flags == probe->volume.flags;
}

// Holds the running image (see the block comment). The main image is found from kernel-held data
// (WindowsTargetKernelImageInfo), never from the target's module list. `recorded` is the process's
// path as read before (QueryFullProcessImageNameW), or std::nullopt when it could not be read.
// False when the kernel data is unreadable or its file cannot be held.
//
// `matches` is anchored by re-reading the kernel image name (QueryFullProcessImageNameW) after the
// file is held, and requiring that name to open the same file (canonical path and file id) as the
// held one. QueryFullProcessImageNameW names the kernel's image file object, which follows a
// rename of the running image, so a target that unmaps its image and maps another file B at the
// entry point's address (then rewrites its Ldr list) is caught: the re-read still names the real
// image, not B. If that name cannot be read or opened, the result is unresolvable. The held file's
// PE header against the kernel summary, the recorded path still naming the held file, the kernel
// mapped name staying put, and the module list are auxiliary deny-side checks on top.
// Whether the held file is on a volume whose 128-bit file id is stable (NTFS or ReFS). On FAT and
// similar the id is not dependable, so file-id matching cannot be trusted and the target is
// unresolvable. Network and removable volumes are already W-UR by imageVolume.
bool WindowsTargetStableIdVolume(HANDLE file) {
  const std::optional<WindowsTargetVolume> volume = WindowsTargetReadVolume(file);
  return volume.has_value() && WindowsTargetFileSystemHasStableId(volume->file_system);
}

// Whether the process's running image is known to be local, from the kernel's name of it
// (PROCESS_NAME_NATIVE), before the file is opened (S5-c-3 PR-5): an image on a network redirector,
// or one whose name cannot be read, is never opened or read, since an unresponsive share would hold
// the helper's one request lane. Such a target stays unmeasured (unresolvable).
bool WindowsTargetImageKnownLocal(HANDLE process) {
  std::vector<wchar_t> name(32'768, L'\0');
  DWORD length = static_cast<DWORD>(name.size());
  if (QueryFullProcessImageNameW(process, PROCESS_NAME_NATIVE, name.data(), &length) != TRUE ||
      length == 0 || length >= name.size())
    return false;
  const std::optional<std::string> native =
      WindowsTargetUtf8(std::wstring_view(name.data(), length));
  return native.has_value() && !sprint_coder::computer_use::WindowsNativeImageIsRemote(*native);
}

bool HoldWindowsTargetRunningImage(HANDLE process,
                                   const std::optional<std::wstring> &recorded,
                                   WindowsTargetHeldImage *held) {
  const std::optional<WindowsTargetKernelImage> kernel = WindowsTargetKernelImageInfo(process);
  if (!kernel.has_value())
    return false;
  held->il_only_anchor = kernel->il_only_anchor;
  const std::wstring global = L"\\\\?\\GLOBALROOT" + kernel->mapped_name;
  held->file.value =
      CreateFileW(global.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (held->file.value == INVALID_HANDLE_VALUE) {
    held->file.value = nullptr;
    return false;
  }
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(held->file.value, FileAttributeTagInfo, &tag,
                                    sizeof(tag)) ||
      (tag.FileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !ReadWindowsFileIdentity(held->file.value, &held->identity) ||
      !CanonicalWindowsPathFromHandle(held->file.value, &held->canonical_path))
    return false;
  // Anchor: after holding, the kernel image name (it follows a rename of the running image, unlike
  // a view the target remapped) must open the same file as the one held. The name is read once
  // before the open and once after, and both must agree, so a rename that races the open (to put a
  // hard link to another file at the old name) is caught. The held file must have a single name
  // and sit on a volume with a stable 128-bit file id. Anything unreadable -> W-UR.
  std::wstring kernel_path_before;
  std::wstring kernel_path_after;
  const std::optional<WindowsPathIdentity> kernel_file =
      ReadProcessPath(process, &kernel_path_before)
          ? WindowsTargetOpenPathIdentity(kernel_path_before)
          : std::nullopt;
  const bool anchored =
      kernel_file.has_value() && ReadProcessPath(process, &kernel_path_after) &&
      SameWindowsTargetName(kernel_path_before, kernel_path_after) &&
      SameWindowsTargetName(kernel_file->canonical_path, held->canonical_path) &&
      SameWindowsFileIdentity(kernel_file->identity, held->identity) &&
      WindowsTargetStableIdVolume(held->file.value);
  held->volume = WindowsTargetReadVolume(held->file.value);
  held->remote = WindowsTargetFileIsRemote(held->file.value);
  // Auxiliary deny-side checks.
  const bool header_disagrees = WindowsHeldImageDisagreesWithKernel(held->file.value, *kernel);
  const std::optional<WindowsTargetKernelImage> again =
      WindowsTargetKernelImageInfo(process, held->file.value);
  bool recorded_agrees = recorded.has_value();
  if (recorded_agrees) {
    const std::optional<WindowsPathIdentity> recorded_file =
        WindowsTargetOpenPathIdentity(*recorded);
    recorded_agrees = recorded_file.has_value() &&
                      SameWindowsFileIdentity(recorded_file->identity, held->identity);
  }
  const std::optional<std::wstring> module_list = WindowsTargetModuleListImageName(process);
  const bool module_list_agrees =
      module_list.has_value() && SameWindowsTargetName(*module_list, kernel->mapped_name);
  // The held file's bytes are the ones mapped only if nothing rewrote it after the process was
  // created (process herpaderping: a writer that kept its handle across the section's creation
  // overwrites the file, and the signature and resources would then be read from the new bytes).
  // The hold shares no write, so nothing can write while it is held; what was written before is
  // told by the file's ChangeTime, which must be before the creation time (LastWriteTime is not
  // judged; see WindowsImageUnchangedSinceCreation). A rename also moves ChangeTime, so a running
  // image renamed since its start is a mismatch too. FILE_BASIC_INFO unreadable: a mismatch.
  FILE_BASIC_INFO basic{};
  const bool basic_read = GetFileInformationByHandleEx(held->file.value, FileBasicInfo, &basic,
                                                       sizeof(basic)) == TRUE;
  held->unchanged = sprint_coder::computer_use::WindowsImageUnchangedSinceCreation(
      basic_read ? std::optional<sprint_coder::computer_use::WindowsImageFileTimes>(
                       {basic.ChangeTime.QuadPart, basic.LastWriteTime.QuadPart})
                 : std::nullopt,
      WindowsTargetCreationTime(process));
  held->matches = anchored && !header_disagrees && again.has_value() &&
                  SameWindowsTargetName(again->mapped_name, kernel->mapped_name) &&
                  recorded_agrees && module_list_agrees && held->unchanged;
  return true;
}

std::optional<std::string> WindowsTargetVolumeKind(HANDLE file) {
  FILE_REMOTE_PROTOCOL_INFO remote{};
  if (GetFileInformationByHandleEx(file, FileRemoteProtocolInfo, &remote,
                                   sizeof(remote)))
    return "network";
  constexpr DWORD flags = FILE_NAME_NORMALIZED | VOLUME_NAME_GUID;
  std::vector<wchar_t> buffer(32'768, L'\0');
  const DWORD length = GetFinalPathNameByHandleW(
      file, buffer.data(), static_cast<DWORD>(buffer.size()), flags);
  if (length == 0 || length >= buffer.size())
    return std::nullopt;
  const std::wstring path(buffer.data(), length);
  static constexpr std::wstring_view volume_prefix = L"\\\\?\\Volume{";
  const std::size_t end = path.find(L'\\', volume_prefix.size());
  if (!path.starts_with(volume_prefix) || end == std::wstring::npos)
    return std::nullopt;
  const std::wstring root = path.substr(0, end + 1);
  switch (GetDriveTypeW(root.c_str())) {
  case DRIVE_REMOTE:
    return "network";
  case DRIVE_REMOVABLE:
  case DRIVE_CDROM:
  case DRIVE_RAMDISK:
    return "removable";
  case DRIVE_FIXED:
    break;
  default:
    return std::nullopt;
  }
  ScopedKernelHandle volume(CreateFileW(
      path.substr(0, end).c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, 0, nullptr));
  if (volume.value == INVALID_HANDLE_VALUE)
    return std::nullopt;
  STORAGE_PROPERTY_QUERY query{};
  query.PropertyId = StorageDeviceProperty;
  query.QueryType = PropertyStandardQuery;
  std::array<std::uint8_t, 1024> descriptor{};
  DWORD returned = 0;
  if (!DeviceIoControl(volume.value, IOCTL_STORAGE_QUERY_PROPERTY, &query,
                       sizeof(query), descriptor.data(),
                       static_cast<DWORD>(descriptor.size()), &returned,
                       nullptr) ||
      returned < sizeof(STORAGE_DEVICE_DESCRIPTOR))
    return std::nullopt;
  STORAGE_DEVICE_DESCRIPTOR device{};
  std::memcpy(&device, descriptor.data(), sizeof(device));
  switch (device.BusType) {
  case BusTypeUsb:
  case BusType1394:
  case BusTypeSd:
  case BusTypeMmc:
  case BusTypeFileBackedVirtual:
    return "removable";
  case BusTypeiScsi:
    return "network";
  default:
    return "fixed";
  }
}

// The verified signer of the state WinVerifyTrust left open.
bool ReadWindowsTargetSigner(HANDLE state, WindowsTargetSignature *signature) {
  CRYPT_PROVIDER_DATA *provider = WTHelperProvDataFromStateData(state);
  CRYPT_PROVIDER_SGNR *signer =
      provider == nullptr ? nullptr
                          : WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0);
  CRYPT_PROVIDER_CERT *leaf =
      signer == nullptr ? nullptr : WTHelperGetProvCertFromChain(signer, 0);
  if (leaf == nullptr || leaf->pCert == nullptr ||
      signer->pChainContext == nullptr)
    return false;
  std::array<std::uint8_t, 32> thumbprint{};
  DWORD thumbprint_bytes = static_cast<DWORD>(thumbprint.size());
  if (CertGetCertificateContextProperty(leaf->pCert, CERT_SHA256_HASH_PROP_ID,
                                        thumbprint.data(),
                                        &thumbprint_bytes) != TRUE ||
      thumbprint_bytes != thumbprint.size())
    return false;
  static constexpr char hexadecimal[] = "0123456789abcdef";
  signature->thumbprint.clear();
  for (const std::uint8_t byte : thumbprint) {
    signature->thumbprint += hexadecimal[byte >> 4];
    signature->thumbprint += hexadecimal[byte & 0xf];
  }
  void *organization_oid = const_cast<char *>(szOID_ORGANIZATION_NAME);
  const DWORD characters = CertGetNameStringW(
      leaf->pCert, CERT_NAME_ATTR_TYPE, 0, organization_oid, nullptr, 0);
  if (characters == 1) {
    signature->organization = std::string{};
  } else if (characters > 1 && characters <= 1'024) {
    std::wstring organization(characters, L'\0');
    if (CertGetNameStringW(leaf->pCert, CERT_NAME_ATTR_TYPE, 0,
                           organization_oid, organization.data(),
                           characters) == characters) {
      organization.resize(characters - 1);
      signature->organization = WindowsTargetUtf8(organization);
    }
  }
  // A Microsoft product root (the policy without flags), or the application root (Microsoft Root
  // Certificate Authority 2011), which that flag checks instead of the product roots.
  for (const DWORD flags :
       {DWORD{0}, DWORD{MICROSOFT_ROOT_CERT_CHAIN_POLICY_CHECK_APPLICATION_ROOT_FLAG}}) {
    CERT_CHAIN_POLICY_PARA policy{};
    policy.cbSize = sizeof(policy);
    policy.dwFlags = flags;
    CERT_CHAIN_POLICY_STATUS status{};
    status.cbSize = sizeof(status);
    if (CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_MICROSOFT_ROOT,
                                         signer->pChainContext, &policy,
                                         &status) != TRUE) {
      signature->microsoft_root.reset();
      break;
    }
    signature->microsoft_root = status.dwError == ERROR_SUCCESS;
    if (*signature->microsoft_root)
      break;
  }
  return true;
}

// Runs WinVerifyTrust (decision K: no revocation, no network) and reads the signer on success.
// The verdict, or std::nullopt when it verified but its signer could not be read.
std::optional<LONG> VerifyWindowsTargetTrust(WINTRUST_DATA *trust,
                                             WindowsTargetSignature *signature,
                                             DWORD *last_error = nullptr) {
  trust->cbStruct = sizeof(*trust);
  trust->dwUIChoice = WTD_UI_NONE;
  trust->fdwRevocationChecks = WTD_REVOKE_NONE;
  trust->dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE |
                       WTD_DISABLE_MD2_MD4;
  trust->dwStateAction = WTD_STATEACTION_VERIFY;
  GUID policy = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG verified = WinVerifyTrust(nullptr, &policy, trust);
  // GetLastError() right after WinVerifyTrust tells apart a truly absent signature from a present
  // but malformed one (both can return TRUST_E_NOSIGNATURE); the close below overwrites it.
  if (last_error != nullptr)
    *last_error = GetLastError();
  const bool read = verified == ERROR_SUCCESS &&
                    ReadWindowsTargetSigner(trust->hWVTStateData, signature);
  trust->dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(nullptr, &policy, trust);
  if (verified == ERROR_SUCCESS && !read)
    return std::nullopt;
  return verified;
}

bool RewindWindowsTargetFile(HANDLE file) {
  LARGE_INTEGER beginning{};
  return SetFilePointerEx(file, beginning, nullptr, FILE_BEGIN) == TRUE;
}

// A catalog that carries the file's hash (SHA-256, then SHA-1 for older catalogs). The state is
// "unsigned" when no catalog carries it, and std::nullopt when the catalogs cannot be asked.
WindowsTargetSignature VerifyWindowsTargetCatalog(HANDLE file,
                                                  const std::wstring &path) {
  WindowsTargetSignature signature;
  for (const wchar_t *algorithm : {BCRYPT_SHA256_ALGORITHM, BCRYPT_SHA1_ALGORITHM}) {
    HCATADMIN admin = nullptr;
    if (!CryptCATAdminAcquireContext2(&admin, nullptr, algorithm, nullptr, 0) ||
        admin == nullptr)
      return signature;
    DWORD hash_bytes = 0;
    std::vector<std::uint8_t> hash;
    bool hashed = RewindWindowsTargetFile(file);
    if (hashed) {
      CryptCATAdminCalcHashFromFileHandle2(admin, file, &hash_bytes, nullptr, 0);
      hash.resize(hash_bytes);
      hashed = hash_bytes > 0 && hash_bytes <= 64 && RewindWindowsTargetFile(file) &&
               CryptCATAdminCalcHashFromFileHandle2(admin, file, &hash_bytes,
                                                    hash.data(), 0) == TRUE;
    }
    if (!hashed) {
      CryptCATAdminReleaseContext(admin, 0);
      return signature;
    }
    HCATINFO catalog = CryptCATAdminEnumCatalogFromHash(
        admin, hash.data(), hash_bytes, 0, nullptr);
    if (catalog == nullptr) {
      // Only ERROR_NOT_FOUND means "no catalog carries this hash"; any other reason (the catalog
      // store locked, CryptSvc stopped, out of memory) is unresolvable, not "unsigned", so a
      // catalog-signed Microsoft binary is not let through to the upper class by a transient error.
      const DWORD error = GetLastError();
      CryptCATAdminReleaseContext(admin, 0);
      if (error == ERROR_NOT_FOUND)
        continue;
      return signature;
    }
    CATALOG_INFO information{};
    information.cbStruct = sizeof(information);
    std::wstring tag;
    static constexpr wchar_t hexadecimal[] = L"0123456789ABCDEF";
    for (const std::uint8_t byte : hash) {
      tag += hexadecimal[byte >> 4];
      tag += hexadecimal[byte & 0xf];
    }
    std::optional<LONG> verified;
    if (CryptCATCatalogInfoFromContext(catalog, &information, 0) == TRUE &&
        RewindWindowsTargetFile(file)) {
      WINTRUST_CATALOG_INFO member{};
      member.cbStruct = sizeof(member);
      member.pcwszCatalogFilePath = information.wszCatalogFile;
      member.pcwszMemberTag = tag.c_str();
      member.pcwszMemberFilePath = path.c_str();
      member.hMemberFile = file;
      member.pbCalculatedFileHash = hash.data();
      member.cbCalculatedFileHash = hash_bytes;
      member.hCatAdmin = admin;
      WINTRUST_DATA trust{};
      trust.dwUnionChoice = WTD_CHOICE_CATALOG;
      trust.pCatalog = &member;
      verified = VerifyWindowsTargetTrust(&trust, &signature);
    }
    CryptCATAdminReleaseCatalogContext(admin, catalog, 0);
    CryptCATAdminReleaseContext(admin, 0);
    if (!verified.has_value())
      return signature;
    signature.source = WindowsTargetSignatureSource::kCatalog;
    signature.state = *verified == ERROR_SUCCESS ? "valid" : "invalid";
    return signature;
  }
  signature.state = "unsigned";
  return signature;
}

// Whether the held file has an embedded certificate table (the security data directory), or
// std::nullopt when its header cannot be read or does not say (unknown, never "none").
std::optional<bool> WindowsTargetHasCertTable(HANDLE file) {
  std::vector<std::uint8_t> header(64 * 1024);
  OVERLAPPED at{};
  DWORD read = 0;
  if (ReadFile(file, header.data(), static_cast<DWORD>(header.size()), &read, &at) != TRUE)
    return std::nullopt;
  header.resize(read);
  const std::optional<sprint_coder::computer_use::PeImageSummary> summary =
      sprint_coder::computer_use::ParsePeImageSummary(header);
  return summary.has_value() ? summary->has_cert_table : std::nullopt;
}

// The embedded signature, or the catalog when the file carries none. A present embedded signature
// that does not verify is invalid; the catalog is not asked to stand in for it. "Carries none" is
// decided as the Microsoft sample does: WinVerifyTrust returns TRUST_E_NOSIGNATURE and GetLastError
// is one of NOSIGNATURE / SUBJECT_FORM_UNKNOWN / PROVIDER_UNKNOWN, and the PE has no certificate
// table. A NOSIGNATURE verdict with any other last error, or with a certificate table present (a
// malformed or truncated embedded signature), is invalid, not a reason to try the catalog.
WindowsTargetSignature VerifyWindowsTargetSignature(HANDLE file,
                                                    const std::wstring &path) {
  WindowsTargetSignature signature;
  if (!RewindWindowsTargetFile(file))
    return signature;
  WINTRUST_FILE_INFO file_info{};
  file_info.cbStruct = sizeof(file_info);
  file_info.pcwszFilePath = path.c_str();
  file_info.hFile = file;
  WINTRUST_DATA trust{};
  trust.dwUnionChoice = WTD_CHOICE_FILE;
  trust.pFile = &file_info;
  DWORD last_error = 0;
  const std::optional<LONG> verified = VerifyWindowsTargetTrust(&trust, &signature, &last_error);
  if (!verified.has_value())
    return signature;
  if (*verified == ERROR_SUCCESS) {
    signature.source = WindowsTargetSignatureSource::kEmbedded;
    signature.state = "valid";
    return signature;
  }
  const bool no_signature =
      *verified == TRUST_E_NOSIGNATURE &&
      (last_error == static_cast<DWORD>(TRUST_E_NOSIGNATURE) ||
       last_error == static_cast<DWORD>(TRUST_E_SUBJECT_FORM_UNKNOWN) ||
       last_error == static_cast<DWORD>(TRUST_E_PROVIDER_UNKNOWN)) &&
      // Only a header that says "no certificate table" lets the catalog be asked; an unknown one
      // is invalid (fail closed).
      WindowsTargetHasCertTable(file) == std::optional<bool>(false);
  if (no_signature)
    return VerifyWindowsTargetCatalog(file, path);
  signature.source = WindowsTargetSignatureSource::kEmbedded;
  signature.state = "invalid";
  return signature;
}

std::optional<std::string> WindowsTargetPeSubsystem(HANDLE file) {
  std::vector<std::uint8_t> header(64 * 1024);
  OVERLAPPED at{};
  DWORD read = 0;
  if (ReadFile(file, header.data(), static_cast<DWORD>(header.size()), &read,
               &at) != TRUE)
    return std::nullopt;
  header.resize(read);
  return sprint_coder::computer_use::ParsePeSubsystem(header);
}

// The resource section of the held file, copied out of an image view of the held handle itself.
// The file is never opened again by its path: a path loses what the handle names (a Win32 path
// drops a trailing dot or space, so "app.exe." and "app.exe" name two files, and a path longer than
// MAX_PATH would not open), while the held handle cannot be written, renamed or deleted under it.
// The view is an image section (SEC_IMAGE_NO_EXECUTE, which needs only the GENERIC_READ the hold
// has, and maps nothing executable), so the kernel lays the file out as the loader does and refuses
// what it would not load. The view's base is not handed to FindResourceW: a base whose low bits are
// clear reads to the loader as a module it mapped, and its lookup may go to a language's .mui file
// (another, unverified file); the resources are found by FindPeResources instead. A section page
// that is not committed and readable (a section without IMAGE_SCN_MEM_READ maps no-access) is not
// read, and every read of the view (the header and the section) is a copy into a local buffer made
// by CopyWindowsTargetView under SEH, so neither a crafted image nor a page-in that fails (an SMB
// share dropped, a USB volume pulled, a bad sector: EXCEPTION_IN_PAGE_ERROR) can fault this helper;
// either makes the read unresolvable. Only the copies are parsed. `present` false: the image has
// no resources. std::nullopt: the image cannot be mapped or read (the facts read from it are then
// unmeasured).
struct WindowsTargetResourceSection {
  sprint_coder::computer_use::PeResourceSection where;
  std::vector<std::uint8_t> bytes;
};

// Copies `length` bytes of a mapped view. A fault while doing so (EXCEPTION_IN_PAGE_ERROR when the
// page cannot be read in, EXCEPTION_ACCESS_VIOLATION when it is not accessible) is caught and is
// false; any other exception passes on. No C++ object lives here (SEH cannot unwind one, C2712).
bool CopyWindowsTargetView(void *destination, const void *source, std::size_t length) {
  __try {
    std::memcpy(destination, source, length);
  } __except (GetExceptionCode() == EXCEPTION_IN_PAGE_ERROR ||
                      GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION
                  ? EXCEPTION_EXECUTE_HANDLER
                  : EXCEPTION_CONTINUE_SEARCH) {
    return false;
  }
  return true;
}

std::optional<WindowsTargetResourceSection> ReadWindowsTargetResourceSection(HANDLE file) {
  ScopedKernelHandle mapping(CreateFileMappingW(
      file, nullptr, PAGE_READONLY | SEC_IMAGE_NO_EXECUTE, 0, 0, nullptr));
  if (mapping.value == nullptr)
    return std::nullopt;
  const auto *view = static_cast<const std::uint8_t *>(
      MapViewOfFile(mapping.value, FILE_MAP_READ, 0, 0, 0));
  if (view == nullptr)
    return std::nullopt;
  struct Unmap {
    const void *view;
    ~Unmap() { UnmapViewOfFile(view); }
  } unmap{view};
  // Whether [offset, offset + length) of the view is committed and readable, page region by region.
  const auto readable = [view](std::size_t offset, std::size_t length) {
    std::size_t at = offset;
    while (at < offset + length) {
      MEMORY_BASIC_INFORMATION region{};
      if (VirtualQuery(view + at, &region, sizeof(region)) != sizeof(region) ||
          region.AllocationBase != view || region.State != MEM_COMMIT ||
          (region.Protect & (PAGE_GUARD | PAGE_NOACCESS)) != 0 ||
          (region.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY)) == 0)
        return false;
      const std::size_t region_end = static_cast<std::size_t>(
          static_cast<const std::uint8_t *>(region.BaseAddress) + region.RegionSize - view);
      if (region_end <= at)
        return false;
      at = region_end;
    }
    return true;
  };
  // The header page (the first region of the view), up to 64 KiB of it.
  MEMORY_BASIC_INFORMATION first{};
  if (VirtualQuery(view, &first, sizeof(first)) != sizeof(first))
    return std::nullopt;
  const std::size_t header_size =
      first.RegionSize < 64 * 1024 ? static_cast<std::size_t>(first.RegionSize) : 64 * 1024;
  std::vector<std::uint8_t> header(header_size);
  if (!readable(0, header_size) || !CopyWindowsTargetView(header.data(), view, header_size))
    return std::nullopt;
  WindowsTargetResourceSection result;
  const std::optional<sprint_coder::computer_use::PeResourceSection> where =
      sprint_coder::computer_use::LocatePeResourceSection(header);
  if (!where.has_value())
    return std::nullopt;
  result.where = *where;
  if (!where->present)
    return result;
  result.bytes.resize(where->section_size);
  if (!readable(where->section_rva, where->section_size) ||
      !CopyWindowsTargetView(result.bytes.data(), view + where->section_rva, where->section_size))
    return std::nullopt;
  return result;
}

// One resource (id 1 of `type`) of a resource section, or std::nullopt when it cannot be read.
// Absent: an empty list.
std::optional<std::vector<std::span<const std::uint8_t>>>
WindowsTargetResources(const WindowsTargetResourceSection &section, std::uint16_t type) {
  if (!section.where.present)
    return std::vector<std::span<const std::uint8_t>>{};
  return sprint_coder::computer_use::FindPeResources(section.bytes, section.where.section_rva,
                                                     section.where.directory_rva, type, 1);
}

// OriginalFilename of version resource 1: "" when there is none, std::nullopt when it cannot be
// read or when its languages disagree (a name the loader might pick is then not one this can say).
std::optional<std::string> WindowsTargetSectionOriginalFilename(
    const WindowsTargetResourceSection &section) {
  const std::optional<std::vector<std::span<const std::uint8_t>>> versions =
      WindowsTargetResources(section, 16 /* RT_VERSION */);
  if (!versions.has_value())
    return std::nullopt;
  std::optional<std::string> original = std::string{};
  for (std::size_t index = 0; index < versions->size(); ++index) {
    const std::optional<std::string> read =
        sprint_coder::computer_use::VersionInfoOriginalFilename((*versions)[index]);
    if (!read.has_value() || (index > 0 && read != original))
      return std::nullopt;
    original = read;
  }
  return original;
}

// The manifest's execution level and, when the signature verified, OriginalFilename, read from the
// held file through its handle (ReadWindowsTargetResourceSection). The manifest asks for elevation
// when any of its languages does (the deny direction); without one the process runs as the invoker.
void ReadWindowsTargetResources(HANDLE file, bool signature_verified,
                                sprint_coder::computer_use::TargetFacts *facts) {
  if (!signature_verified)
    facts->original_filename = std::string{};
  const std::optional<WindowsTargetResourceSection> section =
      ReadWindowsTargetResourceSection(file);
  if (!section.has_value())
    return;
  const std::optional<std::vector<std::span<const std::uint8_t>>> manifests =
      WindowsTargetResources(*section, 24 /* RT_MANIFEST */);
  if (manifests.has_value()) {
    std::optional<bool> elevated = false;
    for (const std::span<const std::uint8_t> manifest : *manifests) {
      const std::optional<bool> level = sprint_coder::computer_use::ManifestRequiresAdministrator(
          std::string_view(reinterpret_cast<const char *>(manifest.data()), manifest.size()));
      if (!level.has_value()) {
        elevated.reset();
        break;
      }
      elevated = *elevated || *level;
    }
    facts->requires_administrator = elevated;
  }
  if (signature_verified)
    facts->original_filename = WindowsTargetSectionOriginalFilename(*section);
}

// OriginalFilename of an image held by the caller, whatever its signature ("" without one), for
// the deny direction only, read through the held handle. std::nullopt when it cannot be read.
std::optional<std::string> WindowsTargetOriginalFilename(HANDLE file) {
  const std::optional<WindowsTargetResourceSection> section =
      ReadWindowsTargetResourceSection(file);
  if (!section.has_value())
    return std::nullopt;
  return WindowsTargetSectionOriginalFilename(*section);
}

std::optional<std::vector<std::uint8_t>> WindowsTargetTokenInformation(
    HANDLE token, TOKEN_INFORMATION_CLASS information_class) {
  DWORD bytes = 0;
  GetTokenInformation(token, information_class, nullptr, 0, &bytes);
  if (bytes == 0 || bytes > 64 * 1024)
    return std::nullopt;
  std::vector<std::uint8_t> buffer(bytes);
  if (GetTokenInformation(token, information_class, buffer.data(), bytes,
                          &bytes) != TRUE)
    return std::nullopt;
  return buffer;
}

std::optional<DWORD> WindowsTargetTokenDword(HANDLE token,
                                             TOKEN_INFORMATION_CLASS information_class) {
  DWORD value = 0;
  DWORD bytes = 0;
  if (GetTokenInformation(token, information_class, &value, sizeof(value),
                          &bytes) != TRUE ||
      bytes != sizeof(value))
    return std::nullopt;
  return value;
}

std::optional<DWORD> WindowsTargetIntegrityRid(HANDLE token) {
  const std::optional<std::vector<std::uint8_t>> label =
      WindowsTargetTokenInformation(token, TokenIntegrityLevel);
  if (!label.has_value() || label->size() < sizeof(TOKEN_MANDATORY_LABEL))
    return std::nullopt;
  const auto *mandatory =
      reinterpret_cast<const TOKEN_MANDATORY_LABEL *>(label->data());
  PSID sid = mandatory->Label.Sid;
  if (sid == nullptr || !IsValidSid(sid) || *GetSidSubAuthorityCount(sid) == 0)
    return std::nullopt;
  return *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1u);
}

// The 7 token items. Anything unreadable is the refusing value.
void MeasureWindowsTargetToken(HANDLE process,
                               sprint_coder::computer_use::TargetFacts *facts) {
  facts->token_elevated = true;
  facts->token_other_user = true;
  facts->token_other_session = true;
  facts->token_protected = true;
  facts->token_ui_access = true;
  facts->token_integrity_above_self = true;
  facts->token_app_container = true;
  PROCESS_PROTECTION_LEVEL_INFORMATION protection{};
  if (GetProcessInformation(process, ProcessProtectionLevelInfo, &protection,
                            sizeof(protection)) == TRUE)
    facts->token_protected = protection.ProtectionLevel != PROTECTION_LEVEL_NONE;
  HANDLE own = GetCurrentProcessToken();
  ScopedKernelHandle token;
  if (OpenProcessToken(process, TOKEN_QUERY, &token.value) != TRUE)
    return;
  if (const std::optional<DWORD> elevated =
          WindowsTargetTokenDword(token.value, TokenElevation))
    facts->token_elevated = *elevated != 0;
  const std::optional<std::vector<std::uint8_t>> user =
      WindowsTargetTokenInformation(token.value, TokenUser);
  const std::optional<std::vector<std::uint8_t>> own_user =
      WindowsTargetTokenInformation(own, TokenUser);
  if (user.has_value() && own_user.has_value() &&
      user->size() >= sizeof(TOKEN_USER) && own_user->size() >= sizeof(TOKEN_USER)) {
    PSID target_sid = reinterpret_cast<const TOKEN_USER *>(user->data())->User.Sid;
    PSID own_sid = reinterpret_cast<const TOKEN_USER *>(own_user->data())->User.Sid;
    if (target_sid != nullptr && own_sid != nullptr && IsValidSid(target_sid) &&
        IsValidSid(own_sid))
      facts->token_other_user = EqualSid(target_sid, own_sid) != TRUE;
  }
  const std::optional<DWORD> session = WindowsTargetTokenDword(token.value, TokenSessionId);
  const std::optional<DWORD> own_session = WindowsTargetTokenDword(own, TokenSessionId);
  if (session.has_value() && own_session.has_value())
    facts->token_other_session = *session != *own_session;
  if (const std::optional<DWORD> ui_access =
          WindowsTargetTokenDword(token.value, TokenUIAccess))
    facts->token_ui_access = *ui_access != 0;
  const std::optional<DWORD> integrity = WindowsTargetIntegrityRid(token.value);
  const std::optional<DWORD> own_integrity = WindowsTargetIntegrityRid(own);
  if (integrity.has_value() && own_integrity.has_value())
    facts->token_integrity_above_self = *integrity > *own_integrity;
  if (const std::optional<DWORD> app_container =
          WindowsTargetTokenDword(token.value, TokenIsAppContainer))
    facts->token_app_container = *app_container != 0;
}

std::optional<std::string> WindowsTargetPackageSignatureKind(const std::wstring &full_name) {
#if SPRINT_CODER_HAS_WINDOWS_PACKAGE_CATALOG
  try {
    const winrt::Windows::ApplicationModel::Package package =
        winrt::Windows::Management::Deployment::PackageManager().FindPackageForUser(
            L"", full_name);
    if (package == nullptr)
      return std::nullopt;
    switch (package.SignatureKind()) {
    case winrt::Windows::ApplicationModel::PackageSignatureKind::None:
      return "none";
    case winrt::Windows::ApplicationModel::PackageSignatureKind::Developer:
      return "developer";
    case winrt::Windows::ApplicationModel::PackageSignatureKind::Enterprise:
      return "enterprise";
    case winrt::Windows::ApplicationModel::PackageSignatureKind::Store:
      return "store";
    case winrt::Windows::ApplicationModel::PackageSignatureKind::System:
      return "system";
    }
  } catch (...) {
  }
#else
  (void)full_name;
#endif
  return std::nullopt;
}

// The install location of a package, by its full name, canonicalized. The name comes from the
// target's own package identity (GetPackageFullName on its handle), so this is used only to place
// a target that is already a package: a non-package exe under some X:\WindowsApps is never given
// this root. std::nullopt when the package has no path.
std::optional<std::string> WindowsTargetPackageInstallRoot(const std::wstring &full_name) {
  UINT32 length = 0;
  if (GetPackagePathByFullName(full_name.c_str(), &length, nullptr) !=
          ERROR_INSUFFICIENT_BUFFER ||
      length == 0 || length > 32'768)
    return std::nullopt;
  std::wstring path(length, L'\0');
  if (GetPackagePathByFullName(full_name.c_str(), &length, path.data()) != ERROR_SUCCESS ||
      length == 0)
    return std::nullopt;
  path.resize(length - 1);
  const std::string canonical = CanonicalWindowsTargetDirectory(path);
  if (canonical.empty())
    return std::nullopt;
  return canonical;
}

std::optional<bool> WindowsTargetPackageDevelopmentMode(const std::wstring &full_name) {
  PACKAGE_INFO_REFERENCE reference = nullptr;
  if (OpenPackageInfoByFullName(full_name.c_str(), 0, &reference) != ERROR_SUCCESS)
    return std::nullopt;
  std::optional<bool> development;
  UINT32 bytes = 0;
  UINT32 count = 0;
  constexpr UINT32 filter = PACKAGE_FILTER_HEAD | PACKAGE_FILTER_DIRECT;
  if (GetPackageInfo(reference, filter, &bytes, nullptr, &count) ==
          ERROR_INSUFFICIENT_BUFFER &&
      bytes > 0 && bytes <= 1024 * 1024) {
    std::vector<std::uint8_t> buffer(bytes);
    if (GetPackageInfo(reference, filter, &bytes, buffer.data(), &count) ==
        ERROR_SUCCESS) {
      const auto *packages = reinterpret_cast<const PACKAGE_INFO *>(buffer.data());
      for (UINT32 index = 0; index < count; ++index)
        if (packages[index].packageFullName != nullptr &&
            SameWindowsTargetName(packages[index].packageFullName, full_name))
          development = (packages[index].flags & PACKAGE_PROPERTY_DEVELOPMENT_MODE) != 0;
    }
  }
  ClosePackageInfo(reference);
  return development;
}

void MeasureWindowsTargetPackage(HANDLE process, WindowsTargetFactsMeasurement *measured) {
  sprint_coder::computer_use::TargetFacts &facts = measured->facts;
  UINT32 length = 0;
  const LONG probed = GetPackageFullName(process, &length, nullptr);
  if (probed == APPMODEL_ERROR_NO_PACKAGE) {
    facts.packaged = false;
    facts.package_family = std::string{};
    facts.package_signature_kind = "none";
    facts.package_development_mode = false;
    return;
  }
  if (probed != ERROR_INSUFFICIENT_BUFFER || length == 0 || length > 1024)
    return;
  std::wstring full_name(length, L'\0');
  if (GetPackageFullName(process, &length, full_name.data()) != ERROR_SUCCESS ||
      length == 0)
    return;
  full_name.resize(length - 1);
  facts.packaged = true;
  measured->package_full_name = WindowsTargetUtf8(full_name);
  UINT32 family_length = 0;
  if (GetPackageFamilyName(process, &family_length, nullptr) ==
          ERROR_INSUFFICIENT_BUFFER &&
      family_length > 0 && family_length <= 1024) {
    std::wstring family(family_length, L'\0');
    if (GetPackageFamilyName(process, &family_length, family.data()) ==
            ERROR_SUCCESS &&
        family_length > 0) {
      family.resize(family_length - 1);
      facts.package_family = WindowsTargetUtf8(family);
    }
  }
  UINT32 id_bytes = 0;
  if (PackageIdFromFullName(full_name.c_str(), PACKAGE_INFORMATION_BASIC,
                            &id_bytes, nullptr) == ERROR_INSUFFICIENT_BUFFER &&
      id_bytes > 0 && id_bytes <= 64 * 1024) {
    std::vector<std::uint8_t> id(id_bytes);
    if (PackageIdFromFullName(full_name.c_str(), PACKAGE_INFORMATION_BASIC,
                              &id_bytes, id.data()) == ERROR_SUCCESS) {
      const auto *package = reinterpret_cast<const PACKAGE_ID *>(id.data());
      if (package->publisherId != nullptr)
        measured->package_publisher_id = WindowsTargetUtf8(package->publisherId);
    }
  }
  facts.package_development_mode = WindowsTargetPackageDevelopmentMode(full_name);
  facts.package_signature_kind = WindowsTargetPackageSignatureKind(full_name);
  measured->package_install_root = WindowsTargetPackageInstallRoot(full_name);
}

// Every process with its parent pid, its creation time and its leaf, all from one kernel snapshot
// (NtQuerySystemInformation(SystemProcessInformation), parsed by ParseWindowsProcessSnapshot). No
// process is opened, so a process this helper may not open (a SYSTEM orphan, a protected process)
// still carries its creation time, and a reused pid is told from a parent by time for every node
// (opening each one, as before, left those without a time and adopted them as children). The
// parent pid and the time come from the same snapshot, so they agree with each other. std::nullopt
// when the snapshot cannot be taken or read (the lineage is then not measured).
std::optional<std::vector<sprint_coder::computer_use::WindowsProcessNode>>
SnapshotWindowsTargetProcesses() {
  using NtQuerySystemInformationFn = LONG(WINAPI *)(ULONG, PVOID, ULONG, PULONG);
  static const NtQuerySystemInformationFn query = []() {
    const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    return ntdll == nullptr ? nullptr
                            : reinterpret_cast<NtQuerySystemInformationFn>(
                                  GetProcAddress(ntdll, "NtQuerySystemInformation"));
  }();
  if (query == nullptr)
    return std::nullopt;
  constexpr ULONG kSystemProcessInformation = 5;
  constexpr LONG kStatusInfoLengthMismatch = static_cast<LONG>(0xC0000004L);
  constexpr std::size_t kSnapshotLimit = 64u * 1024u * 1024u;
  std::vector<std::uint8_t> buffer(1024u * 1024u);
  // Processes come and go between the size query and the read, so grow and retry a few times.
  for (int attempt = 0; attempt < 8; ++attempt) {
    ULONG needed = 0;
    const LONG status = query(kSystemProcessInformation, buffer.data(),
                              static_cast<ULONG>(buffer.size()), &needed);
    if (status >= 0)
      return sprint_coder::computer_use::ParseWindowsProcessSnapshot(
          buffer, reinterpret_cast<std::uintptr_t>(buffer.data()), 65'536);
    if (status != kStatusInfoLengthMismatch)
      return std::nullopt;
    const std::size_t grown = std::max<std::size_t>(buffer.size() * 2,
                                                    static_cast<std::size_t>(needed) + 64 * 1024);
    if (grown > kSnapshotLimit)
      return std::nullopt;
    buffer.assign(grown, 0);
  }
  return std::nullopt;
}

struct WindowsTargetDescendant {
  bool shell = false;
  bool console_host = false;
};

// What one descendant is, read from its running image as the target's is (held, with the path it
// was recorded under): a shell when its subsystem is not GUI, or when its leaf, its image's leaf or
// its OriginalFilename is on the W4 leaf table; a console host by the same names. The names are
// read whether or not the image is signed (they only cap). A descendant that cannot be opened, is
// no longer the process the snapshot saw, or whose image cannot be read and held counts as a shell
// (the upper class C). The hold must pass the same gate as the target's own
// (WindowsTargetRunningImageMatches: not remote, and the rename probe followed on the descendant's
// file system); a descendant that does not is a shell too, never "not a shell".
WindowsTargetDescendant
InspectWindowsTargetDescendant(const sprint_coder::computer_use::WindowsProcessNode &node,
                               const std::optional<WindowsTargetRenameProbe> &rename_probe) {
  using namespace sprint_coder::computer_use;
  WindowsTargetDescendant result;
  result.console_host = WindowsLeafIsConsoleHost(node.leaf);
  result.shell = true;
  if (WindowsLeafIsShell(node.leaf))
    return result;
  ScopedKernelHandle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                                         FALSE, node.pid));
  if (process.value == nullptr)
    return result;
  const std::optional<std::uint64_t> creation = WindowsTargetCreationTime(process.value);
  if (!creation.has_value() || !node.creation.has_value() || *creation != *node.creation)
    return result;
  std::wstring recorded_path;
  const std::optional<std::wstring> recorded =
      ReadProcessPath(process.value, &recorded_path)
          ? std::optional<std::wstring>(std::move(recorded_path))
          : std::nullopt;
  WindowsTargetHeldImage held;
  if (!WindowsTargetImageKnownLocal(process.value) ||
      !HoldWindowsTargetRunningImage(process.value, recorded, &held) ||
      !WindowsTargetRunningImageMatches(held.matches, held.remote, held.volume,
                                        rename_probe))
    return result;
  const std::optional<std::string> path = WindowsTargetUtf8(held.canonical_path);
  const std::optional<std::string> subsystem = WindowsTargetPeSubsystem(held.file.value);
  const std::optional<std::string> original = WindowsTargetOriginalFilename(held.file.value);
  if (!path.has_value() || !subsystem.has_value() || !original.has_value())
    return result;
  const std::string leaf = WindowsImageLeaf(*path);
  result.console_host = result.console_host || WindowsLeafIsConsoleHost(leaf) ||
                        WindowsLeafIsConsoleHost(*original);
  result.shell = *subsystem != "gui" || WindowsLeafIsShell(leaf) || WindowsLeafIsShell(*original);
  return result;
}

void MeasureWindowsTargetLineage(const WindowsTargetFactsContext &context,
                                 WindowsTargetFactsMeasurement *measured) {
  using namespace sprint_coder::computer_use;
  const std::optional<std::vector<WindowsProcessNode>> nodes =
      SnapshotWindowsTargetProcesses();
  if (!nodes.has_value() || !measured->creation.has_value())
    return;
  const std::uint64_t creation = *measured->creation;
  for (const WindowsProcessNode &node : *nodes) {
    if (node.pid != measured->pid || node.creation != creation)
      continue;
    for (const WindowsProcessNode &parent : *nodes)
      if (parent.pid == node.parent_pid && parent.pid != node.pid &&
          parent.creation.has_value() && *parent.creation <= creation)
        measured->parent_pid = parent.pid;
  }
  // Every descendant is read from its running image, within a count and a time budget; a set of
  // descendants that does not fit them is not measured (unresolvable). "No shell" covers only the
  // descendants a live parent chain reaches: one below an exited intermediate is not seen (the
  // lineage note in the block comment says why no orphan signal stands in for it).
  const WindowsDescendants below = FindWindowsDescendants(
      *nodes, measured->pid, creation, kWindowsTargetDescendantLimit);
  if (!below.truncated && below.nodes.size() <= kWindowsTargetDescendantInspectLimit) {
    const ULONGLONG deadline = GetTickCount64() + kWindowsTargetDescendantBudgetMs;
    bool shell = false;
    bool pseudo_console = false;
    bool within_budget = true;
    for (const std::size_t index : below.nodes) {
      if (GetTickCount64() > deadline) {
        within_budget = false;
        break;
      }
      const WindowsTargetDescendant descendant =
          InspectWindowsTargetDescendant((*nodes)[index], context.rename_probe);
      shell = shell || descendant.shell;
      pseudo_console = pseudo_console || descendant.console_host;
    }
    if (within_budget && GetTickCount64() <= deadline) {
      measured->facts.descendant_shell = shell;
      measured->facts.descendant_pseudo_console = pseudo_console;
    }
  }
  // Without a lineage root nothing can say what is Sprint Coder's own: not measured.
  if (context.lineage_root_pid == 0)
    return;
  const WindowsDescendants own = FindWindowsDescendants(
      *nodes, context.lineage_root_pid, context.lineage_root_creation,
      kWindowsTargetDescendantLimit);
  bool own_descendant = own.truncated || (measured->pid == context.lineage_root_pid &&
                                          creation == context.lineage_root_creation);
  for (const std::size_t index : own.nodes)
    own_descendant = own_descendant || ((*nodes)[index].pid == measured->pid &&
                                        (*nodes)[index].creation == creation);
  measured->facts.own_descendant = own_descendant;
}

std::optional<std::string> WindowsTargetWindowClass(HWND window, std::uint32_t pid) {
  DWORD owner = 0;
  if (window == nullptr || GetWindowThreadProcessId(window, &owner) == 0 ||
      owner != pid)
    return std::nullopt;
  std::array<wchar_t, 257> name{};
  const int length = GetClassNameW(window, name.data(), static_cast<int>(name.size()));
  if (length <= 0)
    return std::nullopt;
  return WindowsTargetUtf8(std::wstring_view(name.data(), static_cast<std::size_t>(length)));
}

// The facts read from the held running image (S5-c-3 PR-5 split this out of
// MeasureWindowsTargetFacts so the seam can give it a held image whose volume it substitutes: a
// remote volume, another file system than the probe's, or no probe). Every fact it sets is reset
// first, so a measurement is never left with a value from another hold.
void MeasureWindowsTargetHeldFacts(const WindowsTargetHeldImage &held,
                                   const WindowsTargetFactsContext &context,
                                   WindowsTargetFactsMeasurement *out) {
  using namespace sprint_coder::computer_use;
  WindowsTargetFactsMeasurement &measured = *out;
  TargetFacts &facts = measured.facts;
  for (std::optional<std::string> *reset :
       {&facts.image_root, &facts.image_relative_path, &facts.image_leaf, &facts.image_volume,
        &facts.signature, &facts.signer_organization, &facts.pe_subsystem, &facts.original_filename})
    reset->reset();
  for (std::optional<bool> *reset : {&facts.running_image_matches, &facts.signer_microsoft_root,
                                     &facts.signer_is_self, &facts.acceptance_fixture,
                                     &facts.requires_administrator})
    reset->reset();
  measured.image_path.clear();
  measured.file_identity.reset();
  measured.signature_source = WindowsTargetSignatureSource::kNone;
  measured.signer_thumbprint.clear();
  // The running-image anchor rests on QueryFullProcessImageNameW following a rename. The one-time
  // probe confirms that only for the file system it ran on (the temp volume), so the target matches
  // only when the probe followed and the target's own file system is the same. A target on another
  // file system (e.g. temp is NTFS and the target is on ReFS or a Dev Drive) is unresolvable until
  // a probe for that file system is available. Fail closed on anything missing.
  // The held file must also be known not to be remote, checked here on top of the volume class
  // (image_volume "network" is W-UR on its own path).
  facts.running_image_matches = WindowsTargetRunningImageMatches(
      held.matches, held.remote, held.volume, context.rename_probe);
  measured.image_path = held.canonical_path;
  measured.file_identity = held.identity;
  const std::optional<std::string> path = WindowsTargetUtf8(held.canonical_path);
  bool windows_apps_from_package_override = false;
  if (path.has_value()) {
    facts.image_leaf = WindowsImageLeaf(*path);
    if (context.roots.has_value()) {
      WindowsImagePlacement placement = PlaceWindowsImage(*path, *context.roots);
      facts.image_root = std::move(placement.root);
      facts.image_relative_path = std::move(placement.relative_path);
    }
    // A verified package's own install location is its windows_apps root, so a Store app on a
    // volume other than the system drive is placed as a package rather than "other". The override
    // applies only when the standard placement found no known root ("other"): a package under
    // %WINDIR% (SystemApps), Program Files or self_install keeps that root, so a %WINDIR% system
    // package stays windows_directory (W-SYS) and does not slip onto the package route. This is
    // only reached for a target that is itself a package, so it never gives a non-package exe
    // windows_apps either.
    // Kept only for the IL-only gate below: a package override is not limited to WindowsApps.
    if (facts.packaged == std::optional<bool>(true) && facts.image_root == std::string("other") &&
        measured.package_install_root.has_value()) {
      const sprint_coder::computer_use::WindowsImageRootPrefix roots[] = {
          {"windows_apps", *measured.package_install_root}};
      WindowsImagePlacement placement = PlaceWindowsImage(*path, roots);
      if (placement.root == "windows_apps") {
        windows_apps_from_package_override = true;
        facts.image_root = std::move(placement.root);
        facts.image_relative_path = std::move(placement.relative_path);
      }
    }
    facts.acceptance_fixture =
        kWindowsTargetAcceptanceMode &&
        target_eligibility_detail::AsciiLower(*facts.image_leaf) == kWindowsTargetFixtureLeaf;
  }
  facts.image_volume = WindowsTargetVolumeKind(held.file.value);
  // An adjacent .exe.config can select an AppDomainManager that loads arbitrary assemblies.
  // The IL-only anchor is usable only under protected roots, even in an opt-in test build.
  // Use the held file's placement, including a verified package's install root, not its name.
  // windows_apps counts only from the fixed %ProgramFiles%WindowsApps prefix: a loose-registered or
  // external-location package's install root, which the override above also calls windows_apps,
  // can be a folder a standard user writes to.
  if (held.il_only_anchor &&
      facts.image_root != std::optional<std::string>("windows_directory") &&
      facts.image_root != std::optional<std::string>("program_files") &&
      (facts.image_root != std::optional<std::string>("windows_apps") ||
       windows_apps_from_package_override)) {
    facts.running_image_matches = false;
    return;
  }
  // A held file not known to be local already records running_image_matches = false, so its bytes
  // are not read for the signature, the resources or the subsystem: those facts stay unmeasured,
  // which makes the verdict unresolvable (incomplete facts are judged before any rule), and a
  // remote share's owner could otherwise make each read fail or stall.
  if (held.remote != std::optional<bool>(false))
    return;

  const WindowsTargetSignature signature =
      VerifyWindowsTargetSignature(held.file.value, held.canonical_path);
  measured.signature_source = signature.source;
  if (signature.state.has_value()) {
    const bool verified = *signature.state == "valid";
    measured.signer_thumbprint = verified ? signature.thumbprint : std::string{};
    // Decision I: a catalog admits nothing outside %WINDIR%.
    const bool catalog_outside_windows =
        signature.source == WindowsTargetSignatureSource::kCatalog &&
        facts.image_root.value_or("") != "windows_directory";
    facts.signature = verified && catalog_outside_windows ? std::string("unsigned")
                                                          : *signature.state;
    facts.signer_organization = verified ? signature.organization : std::string{};
    facts.signer_microsoft_root = verified ? signature.microsoft_root : false;
    facts.signer_is_self = verified && !context.self_signer_thumbprint.empty() &&
                           signature.thumbprint == context.self_signer_thumbprint;
    ReadWindowsTargetResources(held.file.value, verified, &facts);
  }
  facts.pe_subsystem = WindowsTargetPeSubsystem(held.file.value);
}

// Measures one target process (and the window it is asked about, which may be null). The result
// is only facts: judging them is the core's, and nothing here calls it.
WindowsTargetFactsMeasurement MeasureWindowsTargetFacts(
    std::uint32_t pid, HWND window, const WindowsTargetFactsContext &context) {
  using namespace sprint_coder::computer_use;
  WindowsTargetFactsMeasurement measured;
  measured.pid = pid;
  measured.facts.platform = TargetPlatform::kWin32;
  ScopedKernelHandle process(
      OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid));
  if (process.value == nullptr || GetProcessId(process.value) != pid)
    return measured;
  measured.creation = WindowsTargetCreationTime(process.value);
  if (!measured.creation.has_value())
    return measured;
  TargetFacts &facts = measured.facts;
  MeasureWindowsTargetToken(process.value, &facts);
  MeasureWindowsTargetPackage(process.value, &measured);
  facts.window_class = WindowsTargetWindowClass(window, pid);
  MeasureWindowsTargetLineage(context, &measured);

  // The recorded path first, as V1 reads it, then the running image: a rename in between leaves
  // the recorded path naming another file, which is a mismatch.
  std::wstring recorded_path;
  const std::optional<std::wstring> recorded =
      ReadProcessPath(process.value, &recorded_path)
          ? std::optional<std::wstring>(std::move(recorded_path))
          : std::nullopt;
  WindowsTargetHeldImage held;
  if (!WindowsTargetImageKnownLocal(process.value) ||
      !HoldWindowsTargetRunningImage(process.value, recorded, &held))
    return measured;
  MeasureWindowsTargetHeldFacts(held, context, &measured);
  return measured;
}
// END windows target facts

