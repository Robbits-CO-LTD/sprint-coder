import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source pins for #988 N7-3. These check the native decision, not a TypeScript copy of it.
// OS/API measurements remain in the live seam and the Windows acceptance runs.
const nativeDirectory = join(__dirname, '../../computer-use-native');
const source = readFileSync(
  join(nativeDirectory, 'computer_use_windows_host_target_facts.inc'),
  'utf8',
).replaceAll('\r\n', '\n');

function cut(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to).trim();
}

const matches = cut('bool WindowsTargetRunningImageMatches(', '// Holds the running image');
const remote = cut('std::optional<bool> WindowsTargetFileIsRemote(', '// The volume (');
const volume = cut(
  'std::optional<WindowsTargetVolume> WindowsTargetReadVolume(',
  '// Whether a file system',
);
const rename = cut(
  'std::optional<WindowsTargetRenameProbe> WindowsTargetRenameFollows(',
  '// The context of a measurement',
);

describe('Windows target facts premises (#988 N7-3)', () => {
  it('remote_or_unknown_never_yields_allowing_facts', () => {
    expect(remote).toContain('if (query == nullptr)\n    return std::nullopt;');
    expect(remote).toContain(
      'if (query(file, &status, &device, sizeof(device), kFileFsDeviceInformation) < 0)\n    return std::nullopt;',
    );
    expect(remote).toContain('constexpr ULONG kFileRemoteDevice = 0x10;');
    expect(remote).toContain(
      'if ((device.characteristics & kFileRemoteDevice) != 0)\n    return true;',
    );
    expect(volume).toBe(`std::optional<WindowsTargetVolume> WindowsTargetReadVolume(HANDLE file) {
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
}`);
    expect(matches).toContain('held_matches && remote == std::optional<bool>(false)');
    expect(matches).toContain('probe->follows && volume.has_value() &&');
  });

  it('probe_volume_mismatch_is_unresolvable', () => {
    // Pin the whole predicate: neither filesystem nor flags may become an alternative gate.
    expect(matches)
      .toBe(`bool WindowsTargetRunningImageMatches(bool held_matches, std::optional<bool> remote,
                                      const std::optional<WindowsTargetVolume> &volume,
                                      const std::optional<WindowsTargetRenameProbe> &probe) {
  return held_matches && remote == std::optional<bool>(false) && probe.has_value() &&
         probe->follows && volume.has_value() &&
         volume->file_system == probe->volume.file_system && volume->flags == probe->volume.flags;
}`);
    expect(source).toContain(`facts.running_image_matches = WindowsTargetRunningImageMatches(
      held.matches, held.remote, held.volume, context.rename_probe);`);
    const rules: unknown = JSON.parse(
      readFileSync(join(nativeDirectory, 'deny-ruleset.json'), 'utf8'),
    );
    expect(rules).toMatchObject({
      classes: expect.arrayContaining([{ id: 'W-UR', verdict: 'denied' }]),
      rules: expect.arrayContaining([
        {
          class: 'W-UR',
          platforms: ['win32'],
          when: [{ signal: 'runningImageMatches', match: 'false' }],
        },
      ]),
    });
  });

  it('supplementary_protocol_failure_is_local_only_after_the_primary_says_local', () => {
    // A failed supplementary API must not override a missing/remote primary measurement.
    expect(remote.slice(remote.indexOf('  if (query == nullptr)'))).toBe(`  if (query == nullptr)
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
}`);
  });

  it('rename_probe_failure_never_allows_the_running_image', () => {
    expect(rename).toContain('std::optional<WindowsTargetRenameProbe> result;');
    expect(rename)
      .toContain(`if (!active() || CopyFileW(std::wstring(module.data(), module_length).c_str(), first.c_str(), TRUE) != TRUE)
    return std::nullopt;`);
    expect(rename).toContain(`if (active() &&
      CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
                     CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                     nullptr, nullptr, &startup.StartupInfo,
                     &process)) {`);
    expect(rename).toContain(`if (active() && probe_volume.has_value() && probe_id.has_value()) {
      const bool at_first = names_the_file(first);
      const bool at_second = move(first, second) && names_the_file(second);
      const bool at_third = at_second && move(second, third) && names_the_file(third);
      WindowsTargetRenameProbe probe;
      probe.follows = at_first && at_second && at_third;
      probe.volume = *probe_volume;
      if (active()) result = probe;
    }`);
    expect(rename).toContain(`if (MoveFileExW(from.c_str(), to.c_str(), 0) == TRUE)
          return true;
        const DWORD error = GetLastError();
        if (error != ERROR_SHARING_VIOLATION && error != ERROR_ACCESS_DENIED)
          return false;
        Sleep(50);
      }
      return false;`);
    expect(rename).toMatch(/return result;\s*\}$/u);
    expect(source).toContain('context.rename_probe = WindowsTargetRenameFollows(still_valid);');
    expect(matches).toContain('probe.has_value() &&\n         probe->follows &&');
  });

  it('refs_and_dev_drive_keep_the_same_probe_filesystem_and_flags_contract', () => {
    expect(cut('bool WindowsTargetFileSystemHasStableId(', '// Opens a Win32 path'))
      .toBe(`bool WindowsTargetFileSystemHasStableId(std::string_view file_system) {
  return file_system == "ntfs" || file_system == "refs";
}`);
    // ReFS/Dev Drive have no separate blanket exclusion in this gate. Equality is the contract;
    // this does not claim that an actual Dev Drive or an entire target is eligible.
    expect(matches).not.toMatch(/"ntfs"|"refs"|dev.?drive/iu);
    expect(matches).toContain(
      'volume->file_system == probe->volume.file_system && volume->flags == probe->volume.flags;',
    );
  });
});
