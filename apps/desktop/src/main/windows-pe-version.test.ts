import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readVersionFromPeBuffer,
  readWindowsExecutableFileVersion,
  type WindowsExecutableFileVersion,
} from './windows-pe-version';

// Absolute file offsets of every field this builder writes, computed once for the fixed minimal
// layout below (one section, one RT_VERSION resource, no other resources or data directories).
// Keeping them as named constants makes the corruption tests below say exactly which structure
// they are attacking instead of a bare magic number.
const PE_HEADER_OFFSET = 64;
const OPTIONAL_HEADER_OFFSET = 88;
const SIZE_OF_OPTIONAL_HEADER = 224; // PE32 standard(28) + windows-specific(68) + 16 data dirs(128)
const RESOURCE_DATA_DIRECTORY_OFFSET = OPTIONAL_HEADER_OFFSET + 96 + 2 * 8; // index 2 = resources
const SECTION_TABLE_OFFSET = OPTIONAL_HEADER_OFFSET + SIZE_OF_OPTIONAL_HEADER;
const SECTION_RAW_POINTER = SECTION_TABLE_OFFSET + 40; // one 40-byte section header
const SECTION_VIRTUAL_ADDRESS = 0x2000;
const RESOURCE_ROOT_ENTRY_OFFSET = SECTION_RAW_POINTER + 16; // root dir's one entry, right after its 16-byte header
const VERSION_INFO_RELATIVE_OFFSET = 88; // within the .rsrc section
const VERSION_INFO_FILE_OFFSET = SECTION_RAW_POINTER + VERSION_INFO_RELATIVE_OFFSET;
const VERSION_INFO_LENGTH = 92;
const TOTAL_FILE_LENGTH = VERSION_INFO_FILE_OFFSET + VERSION_INFO_LENGTH;
const VS_FIXEDFILEINFO_OFFSET = VERSION_INFO_FILE_OFFSET + 40;

// Builds the smallest PE32 image this module's parser accepts: a DOS/PE/COFF/optional header, one
// `.rsrc` section, and inside it exactly the resource tree the parser walks — Type(RT_VERSION) ->
// one Name -> one Language -> one VS_VERSIONINFO carrying one VS_FIXEDFILEINFO. Every byte outside
// of that path is left zeroed; the parser never looks at it, and Windows loaders never see this
// buffer (it is not written to disk as a `.exe` in most tests below).
function buildMinimalPeVersionBuffer(version: WindowsExecutableFileVersion): Buffer {
  const buffer = Buffer.alloc(TOTAL_FILE_LENGTH);

  // DOS header: 'MZ' signature, e_lfanew pointing right at the PE header.
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(PE_HEADER_OFFSET, 0x3c);

  // PE signature ('P','E',0,0 as bytes == 0x00004550 little-endian) + 20-byte COFF header.
  buffer.writeUInt32LE(0x00004550, PE_HEADER_OFFSET);
  buffer.writeUInt16LE(0x8664, PE_HEADER_OFFSET + 4); // Machine (unchecked by the parser)
  buffer.writeUInt16LE(1, PE_HEADER_OFFSET + 6); // NumberOfSections
  buffer.writeUInt16LE(SIZE_OF_OPTIONAL_HEADER, PE_HEADER_OFFSET + 20);

  // Optional header: PE32 magic, and the resource entry (index 2) of the data directory.
  buffer.writeUInt16LE(0x10b, OPTIONAL_HEADER_OFFSET);
  buffer.writeUInt32LE(SECTION_VIRTUAL_ADDRESS, RESOURCE_DATA_DIRECTORY_OFFSET); // RVA
  buffer.writeUInt32LE(180, RESOURCE_DATA_DIRECTORY_OFFSET + 4); // Size

  // Section header for `.rsrc`.
  buffer.write('.rsrc', SECTION_TABLE_OFFSET, 'ascii');
  buffer.writeUInt32LE(180, SECTION_TABLE_OFFSET + 8); // VirtualSize
  buffer.writeUInt32LE(SECTION_VIRTUAL_ADDRESS, SECTION_TABLE_OFFSET + 12); // VirtualAddress
  buffer.writeUInt32LE(180, SECTION_TABLE_OFFSET + 16); // SizeOfRawData
  buffer.writeUInt32LE(SECTION_RAW_POINTER, SECTION_TABLE_OFFSET + 20); // PointerToRawData

  // Resource tree, relative to SECTION_RAW_POINTER (== resourceSectionBase for this layout).
  // Level 1 (Type): one IMAGE_RESOURCE_DIRECTORY (relative 0..15) + one entry (relative 16..23).
  buffer.writeUInt16LE(1, SECTION_RAW_POINTER + 14); // NumberOfIdEntries
  buffer.writeUInt32LE(16, RESOURCE_ROOT_ENTRY_OFFSET); // Id = RT_VERSION
  buffer.writeUInt32LE(0x80000000 + 24, RESOURCE_ROOT_ENTRY_OFFSET + 4); // -> subdirectory @ rel 24

  // Level 2 (Name): directory at relative 24, one entry at relative 40.
  buffer.writeUInt16LE(1, SECTION_RAW_POINTER + 24 + 14);
  buffer.writeUInt32LE(1, SECTION_RAW_POINTER + 24 + 16); // arbitrary name id
  buffer.writeUInt32LE(0x80000000 + 48, SECTION_RAW_POINTER + 24 + 20); // -> subdirectory @ rel 48

  // Level 3 (Language): directory at relative 48, one entry at relative 64, leaf -> rel 72.
  buffer.writeUInt16LE(1, SECTION_RAW_POINTER + 48 + 14);
  buffer.writeUInt32LE(0x0409, SECTION_RAW_POINTER + 48 + 16); // en-US
  buffer.writeUInt32LE(72, SECTION_RAW_POINTER + 48 + 20); // leaf: data entry @ rel 72

  // IMAGE_RESOURCE_DATA_ENTRY at relative 72: points (as an RVA) at the VS_VERSIONINFO bytes.
  buffer.writeUInt32LE(
    SECTION_VIRTUAL_ADDRESS + VERSION_INFO_RELATIVE_OFFSET,
    SECTION_RAW_POINTER + 72,
  );
  buffer.writeUInt32LE(VERSION_INFO_LENGTH, SECTION_RAW_POINTER + 72 + 4); // Size

  // VS_VERSIONINFO: header, UTF-16LE "VS_VERSION_INFO\0" key, then the VS_FIXEDFILEINFO.
  buffer.writeUInt16LE(VERSION_INFO_LENGTH, VERSION_INFO_FILE_OFFSET);
  buffer.writeUInt16LE(52, VERSION_INFO_FILE_OFFSET + 2); // wValueLength = sizeof(VS_FIXEDFILEINFO)
  buffer.write('VS_VERSION_INFO\0', VERSION_INFO_FILE_OFFSET + 6, 'utf16le');

  buffer.writeUInt32LE(0xfeef04bd, VS_FIXEDFILEINFO_OFFSET); // dwSignature
  buffer.writeUInt32LE(0x00010000, VS_FIXEDFILEINFO_OFFSET + 4); // dwStrucVersion
  buffer.writeUInt32LE(
    ((version.major & 0xffff) << 16) | (version.minor & 0xffff),
    VS_FIXEDFILEINFO_OFFSET + 8,
  ); // dwFileVersionMS
  buffer.writeUInt32LE((version.build & 0xffff) << 16, VS_FIXEDFILEINFO_OFFSET + 12); // dwFileVersionLS

  return buffer;
}

describe('readVersionFromPeBuffer (synthetic PE, runs on every OS)', () => {
  it('reads the FileVersion out of a well-formed minimal PE image', async () => {
    const version = { major: 22, minor: 14, build: 0 };
    await expect(readVersionFromPeBuffer(buildMinimalPeVersionBuffer(version))).resolves.toEqual(
      version,
    );
  });

  it('reads major, minor and build independently of each other', async () => {
    const version = { major: 23, minor: 6, build: 12 };
    await expect(readVersionFromPeBuffer(buildMinimalPeVersionBuffer(version))).resolves.toEqual(
      version,
    );
  });

  it('returns null for a buffer that is not a PE file at all', async () => {
    await expect(readVersionFromPeBuffer(Buffer.alloc(200))).resolves.toBeNull();
    await expect(readVersionFromPeBuffer(Buffer.from('not a pe file at all'))).resolves.toBeNull();
  });

  it('returns null, and never throws, when truncated at every structural boundary', async () => {
    const whole = buildMinimalPeVersionBuffer({ major: 22, minor: 14, build: 0 });
    const truncationPoints = [
      0, // empty
      32, // inside the DOS header, before e_lfanew
      PE_HEADER_OFFSET + 2, // inside the PE signature
      PE_HEADER_OFFSET + 24 + 4, // inside the optional header
      SECTION_TABLE_OFFSET + 10, // inside the section table
      SECTION_RAW_POINTER + 5, // inside the resource root directory
      SECTION_RAW_POINTER + 24 + 20, // inside the Name-level directory's entry
      SECTION_RAW_POINTER + 72 + 8, // inside the IMAGE_RESOURCE_DATA_ENTRY
      VERSION_INFO_FILE_OFFSET + 10, // inside the szKey
      VS_FIXEDFILEINFO_OFFSET + 4, // inside VS_FIXEDFILEINFO, after the signature
      TOTAL_FILE_LENGTH - 1, // one byte short of complete
    ];
    for (const cutAt of truncationPoints) {
      await expect(readVersionFromPeBuffer(whole.subarray(0, cutAt))).resolves.toBeNull();
    }
  });

  it('returns null for an out-of-range e_lfanew instead of reading past the buffer', async () => {
    const buffer = buildMinimalPeVersionBuffer({ major: 22, minor: 14, build: 0 });
    buffer.writeUInt32LE(0xfffffff0, 0x3c);
    await expect(readVersionFromPeBuffer(buffer)).resolves.toBeNull();
  });

  it('returns null for an out-of-range resource data directory RVA', async () => {
    const buffer = buildMinimalPeVersionBuffer({ major: 22, minor: 14, build: 0 });
    buffer.writeUInt32LE(0x7fffffff, RESOURCE_DATA_DIRECTORY_OFFSET); // RVA outside any section
    await expect(readVersionFromPeBuffer(buffer)).resolves.toBeNull();
  });

  it('returns null when the resource tree has no RT_VERSION entry', async () => {
    const buffer = buildMinimalPeVersionBuffer({ major: 22, minor: 14, build: 0 });
    buffer.writeUInt32LE(3, RESOURCE_ROOT_ENTRY_OFFSET); // RT_ICON instead of RT_VERSION(16)
    await expect(readVersionFromPeBuffer(buffer)).resolves.toBeNull();
  });

  it('returns null when the VS_FIXEDFILEINFO signature does not match', async () => {
    const buffer = buildMinimalPeVersionBuffer({ major: 22, minor: 14, build: 0 });
    buffer.writeUInt32LE(0, VS_FIXEDFILEINFO_OFFSET);
    await expect(readVersionFromPeBuffer(buffer)).resolves.toBeNull();
  });

  it('returns null when the VS_VERSION_INFO key does not match', async () => {
    const buffer = buildMinimalPeVersionBuffer({ major: 22, minor: 14, build: 0 });
    buffer.write('X', VERSION_INFO_FILE_OFFSET + 6, 'utf16le');
    await expect(readVersionFromPeBuffer(buffer)).resolves.toBeNull();
  });

  it('returns null when the DOS signature is not MZ', async () => {
    const buffer = buildMinimalPeVersionBuffer({ major: 22, minor: 14, build: 0 });
    buffer.write('XX', 0, 'ascii');
    await expect(readVersionFromPeBuffer(buffer)).resolves.toBeNull();
  });
});

describe('readWindowsExecutableFileVersion (disk-backed reader)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reads a synthetic PE file written to disk through a real, bounded file handle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sprint-coder-pe-version-'));
    roots.push(dir);
    const version = { major: 22, minor: 9, build: 3 };
    const filePath = join(dir, 'node.exe');
    await writeFile(filePath, buildMinimalPeVersionBuffer(version));
    await expect(readWindowsExecutableFileVersion(filePath)).resolves.toEqual(version);
  });

  it('returns null, without throwing, for a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sprint-coder-pe-version-'));
    roots.push(dir);
    await expect(
      readWindowsExecutableFileVersion(join(dir, 'does-not-exist.exe')),
    ).resolves.toBeNull();
  });

  it('returns null, without throwing, for a directory path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sprint-coder-pe-version-'));
    roots.push(dir);
    await expect(readWindowsExecutableFileVersion(dir)).resolves.toBeNull();
  });

  it('returns null, without throwing, for a truncated file on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sprint-coder-pe-version-'));
    roots.push(dir);
    const filePath = join(dir, 'node.exe');
    const whole = buildMinimalPeVersionBuffer({ major: 22, minor: 14, build: 0 });
    await writeFile(filePath, whole.subarray(0, SECTION_RAW_POINTER + 10));
    await expect(readWindowsExecutableFileVersion(filePath)).resolves.toBeNull();
  });

  it.runIf(process.platform === 'win32')(
    "on win32, reads this process's own node.exe and matches process.versions.node",
    async () => {
      const [major, minor, build] = process.versions.node.split('.').map(Number);
      await expect(readWindowsExecutableFileVersion(process.execPath)).resolves.toEqual({
        major,
        minor,
        build,
      });
    },
  );
});
