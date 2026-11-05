// Exercise the production PIDL-to-item boundary without opening Explorer or sending input.
#define wmain ProductionHostMain
#include "explorer-host.cc"
#undef wmain
#include <stdexcept>

void Require(bool ok, const char *name) {
  if (!ok) { std::cout << "FAIL " << name << std::endl; throw std::runtime_error(name); }
}
bool CreateTestJunction(const std::wstring &path, const std::wstring &target) {
  const std::wstring substitute = L"\\??\\" + target;
  struct MountPoint {
    DWORD tag = IO_REPARSE_TAG_MOUNT_POINT;
    WORD length = 0, reserved = 0;
    WORD substitute_offset = 0, substitute_length = 0, print_offset = 0, print_length = 0;
    wchar_t names[32768]{};
  } data;
  if (substitute.size() + target.size() + 2 >= 32768) return false;
  data.substitute_length = static_cast<WORD>(substitute.size() * sizeof(wchar_t));
  data.print_offset = data.substitute_length + sizeof(wchar_t);
  data.print_length = static_cast<WORD>(target.size() * sizeof(wchar_t));
  data.length = 8 + data.print_offset + data.print_length + sizeof(wchar_t);
  std::copy(substitute.begin(), substitute.end(), data.names);
  std::copy(target.begin(), target.end(), data.names + substitute.size() + 1);
  if (!CreateDirectoryW(path.c_str(), nullptr)) return false;
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  DWORD bytes = 0;
  const bool ok = file != INVALID_HANDLE_VALUE && DeviceIoControl(file, FSCTL_SET_REPARSE_POINT,
      &data, data.length + 8, nullptr, 0, &bytes, nullptr);
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  if (!ok) Require(RemoveDirectoryW(path.c_str()) != FALSE, "empty_junction_cleanup");
  return ok;
}
int wmain(int argc, wchar_t **argv) {
  Require((argc == 2 || argc == 3) && SUCCEEDED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)), "apartment");
  std::wstring incoming = argv[1];
  if (argc == 3) {
    wchar_t shortened[32768]{};
    const DWORD size = GetShortPathNameW(incoming.c_str(), shortened, 32768);
    Require(size > 0 && size < 32768, "short_temp_input");
    incoming.assign(shortened, size);
    if (incoming == argv[1]) std::cout << "NOT_RUN short_temp_alias_unavailable\n";
  }
  wchar_t expanded[32768]{};
  const DWORD length = GetLongPathNameW(incoming.c_str(), expanded, 32768);
  Require(length > 0 && length < 32768, "long_temp_path");
  const std::wstring directory(expanded, length);
  wchar_t short_path[32768]{}, roundtrip[32768]{};
  const DWORD short_length = GetShortPathNameW(directory.c_str(), short_path, 32768);
  if (short_length > 0 && short_length < 32768) {
    Require(GetLongPathNameW(short_path, roundtrip, 32768) == length &&
        WindowsExplorerAsciiEqual(roundtrip, directory), "short_temp_path_expands");
  } else std::cout << "NOT_RUN short_temp_path_unavailable\n";
  const std::wstring folder = directory + L"\\Child";
  const std::wstring link = directory + L"\\Folder.lnk";
  const std::wstring file = directory + L"\\File.txt";
  Require(CreateDirectoryW(folder.c_str(), nullptr) && CreateDirectoryW(link.c_str(), nullptr), "folders");
  HANDLE handle = CreateFileW(file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, 0, nullptr);
  Require(handle != INVALID_HANDLE_VALUE, "file"); CloseHandle(handle);
  PIDLIST_ABSOLUTE parent = nullptr;
  Require(SUCCEEDED(SHParseDisplayName(directory.c_str(), nullptr, &parent, 0, nullptr)), "parent_pidl");
  const SFGAOF folder_attributes = SFGAO_FILESYSTEM | SFGAO_FOLDER;
  const auto measure = [&](const std::wstring &path, SFGAOF attributes = SFGAO_FILESYSTEM | SFGAO_FOLDER,
                           bool current = true) {
    PIDLIST_ABSOLUTE absolute = nullptr;
    Require(SUCCEEDED(SHParseDisplayName(path.c_str(), nullptr, &absolute, 0, nullptr)), "item_pidl");
    auto item = WindowsExplorerItemFromPidl(parent, ILFindLastID(absolute), directory, attributes,
                                           [current] { return current; });
    CoTaskMemFree(absolute);
    return item;
  };
  const auto item = measure(folder);
  Require(item && item->kind == "folder" && item->pidl_digest.size() == 64 &&
      WindowsExplorerAsciiEqual(item->path, folder), "measured_folder_pidl_path_kind");
  Require(measure(folder) == item, "same_pidl_stable");
  Require(SetFileAttributesW(folder.c_str(), FILE_ATTRIBUTE_HIDDEN) != FALSE, "hidden_fixture");
  Require(!measure(folder), "hidden_folder_refused");
  Require(SetFileAttributesW(folder.c_str(), FILE_ATTRIBUTE_SYSTEM) != FALSE, "system_fixture");
  Require(!measure(folder), "system_folder_refused");
  Require(SetFileAttributesW(folder.c_str(), FILE_ATTRIBUTE_NORMAL) != FALSE, "attributes_restore");
  for (const auto suffix : {L".txt", L".EXE", L".zip"}) {
    const auto collision = folder + suffix;
    HANDLE sibling = CreateFileW(collision.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, 0, nullptr);
    Require(sibling != INVALID_HANDLE_VALUE, "collision_fixture"); CloseHandle(sibling);
    Require(!measure(folder), "extension_hidden_collision_refused");
    Require(SetFileAttributesW(folder.c_str(), FILE_ATTRIBUTE_HIDDEN) != FALSE, "hidden_collision_fixture");
    Require(!measure(folder), "hidden_folder_visible_executable_refused");
    Require(SetFileAttributesW(folder.c_str(), FILE_ATTRIBUTE_NORMAL) && DeleteFileW(collision.c_str()),
        "collision_cleanup");
  }
  Require(measure(folder).has_value(), "ordinary_folder_after_collision_removed");
  const auto current = [] { return true; };
  Require(WindowsExplorerUniqueCachedName({L"Child", L"Other"}, L"Child", current),
      "unique_cached_list_item_accepted");
  Require(!WindowsExplorerUniqueCachedName({L"Child", L"child"}, L"Child", current),
      "duplicate_cached_list_item_name_refused");
  Require(!WindowsExplorerUniqueCachedName({L"Other"}, L"Child", current),
      "missing_cached_list_item_name_refused");
  Require(!WindowsExplorerUniqueCachedName({L"Child"}, L"Child", [] { return false; }),
      "cached_name_deadline_refused");
  for (const auto name : {L"v1", L"Project"}) {
    const auto candidate = directory + L"\\" + name;
    const auto sibling = candidate + (std::wstring(name) == L"v1" ? L".2" : L".zip");
    Require(CreateDirectoryW(candidate.c_str(), nullptr) && CreateDirectoryW(sibling.c_str(), nullptr),
        "dotted_folder_fixture");
    Require(measure(candidate).has_value(), "ordinary_dotted_sibling_folder_accepted");
    Require(RemoveDirectoryW(sibling.c_str()) && RemoveDirectoryW(candidate.c_str()), "dotted_folder_cleanup");
  }
  const auto junction_name = folder + L".{21EC2020-3AEA-1069-A2DD-08002B30309D}";
  Require(CreateDirectoryW(junction_name.c_str(), nullptr) != FALSE, "namespace_sibling_fixture");
  Require(!measure(folder), "namespace_sibling_alias_refused");
  Require(RemoveDirectoryW(junction_name.c_str()) != FALSE, "namespace_sibling_cleanup");
  const auto unrelated_file = folder + L".other.txt";
  HANDLE unrelated = CreateFileW(unrelated_file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, 0, nullptr);
  Require(unrelated != INVALID_HANDLE_VALUE, "last_dot_fixture"); CloseHandle(unrelated);
  Require(measure(folder).has_value(), "different_last_dot_basename_accepted");
  Require(DeleteFileW(unrelated_file.c_str()) != FALSE, "last_dot_cleanup");
  const auto impersonator = directory + L"\\Bar";
  const auto ini = impersonator + L"\\desktop.ini";
  Require(CreateDirectoryW(impersonator.c_str(), nullptr) != FALSE, "localized_sibling_fixture");
  Require(SetFileAttributesW(impersonator.c_str(), FILE_ATTRIBUTE_READONLY) != FALSE,
      "readonly_sibling_fixture");
  Require(measure(folder).has_value(), "readonly_sibling_without_ini_accepted");
  Require(WritePrivateProfileStringW(L".ShellClassInfo", L"LocalizedResourceName", L"Child", ini.c_str()) != FALSE,
      "localized_sibling_ini");
  for (DWORD attributes : {FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM}) {
    Require(SetFileAttributesW(impersonator.c_str(), attributes) != FALSE, "localized_sibling_attributes");
    Require(!measure(folder), "sibling_localized_display_name_collision_refused");
  }
  Require(SetFileAttributesW(impersonator.c_str(), FILE_ATTRIBUTE_NORMAL) &&
      DeleteFileW(ini.c_str()) && RemoveDirectoryW(impersonator.c_str()), "localized_sibling_cleanup");
  Require(measure(folder).has_value(), "ordinary_folder_after_localized_sibling_removed");
  const auto bounded = directory + L"\\Bounded";
  const auto bounded_child = bounded + L"\\Child";
  Require(CreateDirectoryW(bounded.c_str(), nullptr) && CreateDirectoryW(bounded_child.c_str(), nullptr),
      "bounded_siblings_fixture");
  for (unsigned index = 0; index < 4095; ++index)
    Require(CreateDirectoryW((bounded + L"\\Entry-" + std::to_wstring(index)).c_str(), nullptr) != FALSE,
        "bounded_sibling_create");
  Require(WindowsExplorerUnambiguousFolder(bounded_child, current), "4096_siblings_accepted");
  Require(CreateDirectoryW((bounded + L"\\Overflow").c_str(), nullptr) != FALSE, "overflow_fixture");
  Require(!WindowsExplorerUnambiguousFolder(bounded_child, current), "4097_siblings_refused");
  Require(RemoveDirectoryW((bounded + L"\\Overflow").c_str()) != FALSE, "overflow_cleanup");
  for (unsigned index = 0; index < 4095; ++index)
    Require(RemoveDirectoryW((bounded + L"\\Entry-" + std::to_wstring(index)).c_str()) != FALSE,
        "bounded_sibling_cleanup");
  Require(RemoveDirectoryW(bounded_child.c_str()) && RemoveDirectoryW(bounded.c_str()), "bounded_cleanup");
  unsigned checks = 0;
  Require(!WindowsExplorerUnambiguousFolder(folder, [&] { return ++checks < 2; }),
      "display_collision_lookup_deadline_refused");
  Require(!measure(file), "file_refused_even_with_folder_claim");
  Require(!measure(link), "lnk_folder_refused");
  Require(!measure(folder, folder_attributes | SFGAO_LINK), "shell_link_refused");
  Require(!measure(folder, SFGAO_FOLDER), "namespace_refused");
  Require(!measure(folder, SFGAO_FILESYSTEM), "non_folder_refused");
  Require(!measure(folder, folder_attributes, false), "cancel_refused");
  PIDLIST_ABSOLUTE absolute = nullptr;
  Require(SUCCEEDED(SHParseDisplayName(folder.c_str(), nullptr, &absolute, 0, nullptr)), "child_pidl");
  Require(!WindowsExplorerItemFromPidl(parent, ILFindLastID(absolute), directory + L"\\Other",
      folder_attributes, [] { return true; }), "direct_child_path_required");
  CoTaskMemFree(absolute);
  const std::wstring reparse = directory + L"\\Reparse";
  if (CreateTestJunction(reparse, folder)) {
    Require(!measure(reparse), "reparse_refused");
    Require(RemoveDirectoryW(reparse.c_str()) != FALSE, "reparse_cleanup");
    std::cout << "OK reparse_junction_refused\n";
  } else {
    std::cout << "NOT_RUN reparse_junction_refused junction_unavailable\n";
  }
  CoTaskMemFree(parent);
  Require(DeleteFileW(file.c_str()) && RemoveDirectoryW(link.c_str()) && RemoveDirectoryW(folder.c_str()),
      "fixture_cleanup");
  CoUninitialize();
  std::cout << "OK Explorer item boundary\n";
  return 0;
}
