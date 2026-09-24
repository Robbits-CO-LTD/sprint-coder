import { open, type FileHandle } from 'node:fs/promises';

// Reads the FileVersion embedded in a Windows PE executable's VS_VERSIONINFO resource, without
// ever running the executable (Issue #549). The caller may be about to reject a command built
// around a file named `node.exe`, but that file could be anything an attacker or a stray tool
// placed in the workspace, so this module only opens it read-only and parses the small, bounded
// byte ranges that make up the PE headers and the version resource. Every offset and size read
// from the file is validated against the file's actual length before it is used to read again;
// a truncated, corrupted, or merely unexpected file yields `null` rather than a thrown error, so
// a hostile or malformed binary can never turn a rejection message into a crash on the command
// path (Issue #549 acceptance criteria).

export type WindowsExecutableFileVersion = Readonly<{
  major: number;
  minor: number;
  build: number;
}>;

// Returns the requested byte range, or `null` when the range falls outside the file (or buffer)
// this reader was built for. Centralizing the bounds check here means every call site below gets
// it for free instead of re-deriving it from a mix of offsets and sizes.
type ByteRangeReader = (offset: number, length: number) => Promise<Buffer | null>;

const IMAGE_DOS_SIGNATURE = 0x5a4d; // 'MZ'
const IMAGE_NT_SIGNATURE = 0x00004550; // 'PE\0\0'
const IMAGE_DIRECTORY_ENTRY_RESOURCE = 2;
const PE32_DATA_DIRECTORY_OFFSET = 96;
const PE32_PLUS_DATA_DIRECTORY_OFFSET = 112;
const IMAGE_RESOURCE_DIRECTORY_SIZE = 16;
const IMAGE_RESOURCE_ENTRY_SIZE = 8;
const IMAGE_SECTION_HEADER_SIZE = 40;
const IMAGE_RESOURCE_DATA_ENTRY_SIZE = 16;
const RT_VERSION = 16;
const VS_FIXEDFILEINFO_SIGNATURE = 0xfeef04bd;
const VS_FIXEDFILEINFO_SIZE = 52;
const VS_VERSION_INFO_KEY = 'VS_VERSION_INFO';
// A real VS_VERSIONINFO resource is a few hundred bytes. A `Size` field far beyond that is either
// a corrupted binary or an attempt to make this module read an unbounded amount of the file.
const MAX_VERSION_RESOURCE_BYTES = 64 * 1024;
// PE files realistically have well under a hundred sections; a larger count only ever comes from
// a corrupted or hostile header.
const MAX_SECTION_COUNT = 96;
// Real RT_VERSION directories have a single entry at every level. Cap generously so a corrupted
// NumberOfNamedEntries/NumberOfIdEntries pair cannot force an oversized read.
const MAX_RESOURCE_DIRECTORY_ENTRIES = 1024;

type Section = Readonly<{
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  rawPointer: number;
}>;

type ResourceDirectoryEntry = Readonly<{
  id: number | null;
  isDirectory: boolean;
  // Offset of the entry's target (a subdirectory or a data entry), relative to the start of the
  // resource section — i.e. directly addable to that section's file offset.
  value: number;
}>;

function rvaToFileOffset(sections: readonly Section[], rva: number): number | null {
  for (const section of sections) {
    const size = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
      const delta = rva - section.virtualAddress;
      if (delta >= section.rawSize) return null;
      return section.rawPointer + delta;
    }
  }
  return null;
}

async function readResourceDirectory(
  read: ByteRangeReader,
  resourceSectionBase: number,
  relativeOffset: number,
): Promise<readonly ResourceDirectoryEntry[] | null> {
  const header = await read(resourceSectionBase + relativeOffset, IMAGE_RESOURCE_DIRECTORY_SIZE);
  if (header === null) return null;
  const namedCount = header.readUInt16LE(12);
  const idCount = header.readUInt16LE(14);
  const total = namedCount + idCount;
  if (total <= 0 || total > MAX_RESOURCE_DIRECTORY_ENTRIES) return null;

  const entriesBuffer = await read(
    resourceSectionBase + relativeOffset + IMAGE_RESOURCE_DIRECTORY_SIZE,
    total * IMAGE_RESOURCE_ENTRY_SIZE,
  );
  if (entriesBuffer === null) return null;

  const entries: ResourceDirectoryEntry[] = [];
  for (let index = 0; index < total; index += 1) {
    const nameField = entriesBuffer.readUInt32LE(index * IMAGE_RESOURCE_ENTRY_SIZE);
    const offsetField = entriesBuffer.readUInt32LE(index * IMAGE_RESOURCE_ENTRY_SIZE + 4);
    const isNamed = (nameField & 0x80000000) !== 0;
    const isDirectory = (offsetField & 0x80000000) !== 0;
    entries.push({
      id: isNamed ? null : nameField & 0xffff,
      isDirectory,
      value: offsetField & 0x7fffffff,
    });
  }
  return entries;
}

// Walks Type (RT_VERSION) -> first Name -> first Language, and returns the file offset of the
// IMAGE_RESOURCE_DATA_ENTRY it leads to. Real Windows executables have exactly one Name and one
// Language under RT_VERSION, so "first" is not a simplification of the real structure.
async function locateVersionResourceDataEntryOffset(
  read: ByteRangeReader,
  resourceSectionBase: number,
): Promise<number | null> {
  const typeEntries = await readResourceDirectory(read, resourceSectionBase, 0);
  if (typeEntries === null) return null;
  const versionType = typeEntries.find((entry) => entry.isDirectory && entry.id === RT_VERSION);
  if (versionType === undefined) return null;

  const nameEntries = await readResourceDirectory(read, resourceSectionBase, versionType.value);
  if (nameEntries === null) return null;
  const firstName = nameEntries[0];
  if (firstName === undefined || !firstName.isDirectory) return null;

  const languageEntries = await readResourceDirectory(read, resourceSectionBase, firstName.value);
  if (languageEntries === null) return null;
  const firstLanguage = languageEntries[0];
  if (firstLanguage === undefined || firstLanguage.isDirectory) return null;

  return resourceSectionBase + firstLanguage.value;
}

// Parses the VS_VERSIONINFO blob down to the VS_FIXEDFILEINFO's FileVersion (MS/LS DWORDs).
function extractFixedFileInfoVersion(buffer: Buffer): WindowsExecutableFileVersion | null {
  // Fixed header (wLength, wValueLength, wType) plus the 16-code-unit "VS_VERSION_INFO\0" key.
  const keyStart = 6;
  const keyByteLength = (VS_VERSION_INFO_KEY.length + 1) * 2;
  if (buffer.length < keyStart + keyByteLength) return null;
  const wValueLength = buffer.readUInt16LE(2);
  const key = buffer.toString('utf16le', keyStart, keyStart + VS_VERSION_INFO_KEY.length * 2);
  if (key !== VS_VERSION_INFO_KEY) return null;
  if (wValueLength < VS_FIXEDFILEINFO_SIZE) return null;

  // VS_FIXEDFILEINFO is DWORD-aligned from the start of the VS_VERSIONINFO structure.
  const keyEnd = keyStart + keyByteLength;
  const valueOffset = (keyEnd + 3) & ~3;
  if (valueOffset + VS_FIXEDFILEINFO_SIZE > buffer.length) return null;

  const signature = buffer.readUInt32LE(valueOffset);
  if (signature !== VS_FIXEDFILEINFO_SIGNATURE) return null;
  const fileVersionMS = buffer.readUInt32LE(valueOffset + 8);
  const fileVersionLS = buffer.readUInt32LE(valueOffset + 12);
  return {
    major: (fileVersionMS >>> 16) & 0xffff,
    minor: fileVersionMS & 0xffff,
    build: (fileVersionLS >>> 16) & 0xffff,
  };
}

// Core parser shared by the disk-backed reader below and by tests, which exercise it against a
// synthetic in-memory PE buffer so the parsing logic itself runs on every OS, not only win32.
export async function parsePeFileVersion(
  read: ByteRangeReader,
  fileSize: number,
): Promise<WindowsExecutableFileVersion | null> {
  try {
    if (fileSize < 64) return null;

    const dosHeader = await read(0, 64);
    if (dosHeader === null) return null;
    if (dosHeader.readUInt16LE(0) !== IMAGE_DOS_SIGNATURE) return null;
    const peHeaderOffset = dosHeader.readUInt32LE(0x3c);
    if (peHeaderOffset + 24 > fileSize) return null;

    // 4-byte PE signature followed by the 20-byte COFF file header.
    const peHeader = await read(peHeaderOffset, 24);
    if (peHeader === null) return null;
    if (peHeader.readUInt32LE(0) !== IMAGE_NT_SIGNATURE) return null;
    const numberOfSections = peHeader.readUInt16LE(6);
    if (numberOfSections <= 0 || numberOfSections > MAX_SECTION_COUNT) return null;
    const sizeOfOptionalHeader = peHeader.readUInt16LE(20);
    const optionalHeaderOffset = peHeaderOffset + 24;
    if (sizeOfOptionalHeader < 2 || optionalHeaderOffset + sizeOfOptionalHeader > fileSize)
      return null;

    const magicBuffer = await read(optionalHeaderOffset, 2);
    if (magicBuffer === null) return null;
    const magic = magicBuffer.readUInt16LE(0);
    const dataDirectoryOffset =
      magic === 0x20b
        ? PE32_PLUS_DATA_DIRECTORY_OFFSET
        : magic === 0x10b
          ? PE32_DATA_DIRECTORY_OFFSET
          : null;
    if (dataDirectoryOffset === null) return null;

    const resourceDirectoryEntryOffset =
      optionalHeaderOffset + dataDirectoryOffset + IMAGE_DIRECTORY_ENTRY_RESOURCE * 8;
    if (resourceDirectoryEntryOffset + 8 > optionalHeaderOffset + sizeOfOptionalHeader) return null;
    const resourceDirectoryEntry = await read(resourceDirectoryEntryOffset, 8);
    if (resourceDirectoryEntry === null) return null;
    const resourceRva = resourceDirectoryEntry.readUInt32LE(0);
    const resourceSize = resourceDirectoryEntry.readUInt32LE(4);
    if (resourceRva === 0 || resourceSize === 0) return null;

    const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
    const sectionTableBytes = numberOfSections * IMAGE_SECTION_HEADER_SIZE;
    if (sectionTableOffset + sectionTableBytes > fileSize) return null;
    const sectionTable = await read(sectionTableOffset, sectionTableBytes);
    if (sectionTable === null) return null;
    const sections: Section[] = [];
    for (let index = 0; index < numberOfSections; index += 1) {
      const base = index * IMAGE_SECTION_HEADER_SIZE;
      sections.push({
        virtualSize: sectionTable.readUInt32LE(base + 8),
        virtualAddress: sectionTable.readUInt32LE(base + 12),
        rawSize: sectionTable.readUInt32LE(base + 16),
        rawPointer: sectionTable.readUInt32LE(base + 20),
      });
    }

    const resourceSectionBase = rvaToFileOffset(sections, resourceRva);
    if (resourceSectionBase === null || resourceSectionBase > fileSize) return null;

    const dataEntryOffset = await locateVersionResourceDataEntryOffset(read, resourceSectionBase);
    if (dataEntryOffset === null) return null;
    const dataEntry = await read(dataEntryOffset, IMAGE_RESOURCE_DATA_ENTRY_SIZE);
    if (dataEntry === null) return null;
    const versionRva = dataEntry.readUInt32LE(0);
    const versionSize = dataEntry.readUInt32LE(4);
    if (versionSize <= 0 || versionSize > MAX_VERSION_RESOURCE_BYTES) return null;

    const versionFileOffset = rvaToFileOffset(sections, versionRva);
    if (versionFileOffset === null || versionFileOffset + versionSize > fileSize) return null;
    const versionBuffer = await read(versionFileOffset, versionSize);
    if (versionBuffer === null) return null;

    return extractFixedFileInfoVersion(versionBuffer);
  } catch {
    // Any unexpected exception (an out-of-range Buffer read this function's own checks failed to
    // catch, an invalid string decode, ...) is treated the same as a recognized malformed input:
    // the caller gets `null`, never an exception (Issue #549 acceptance criteria).
    return null;
  }
}

// Test-only entry point: parses a synthetic or captured PE image already held in memory, with no
// filesystem access at all, so the parser above can be exercised identically on every OS.
export function readVersionFromPeBuffer(
  buffer: Buffer,
): Promise<WindowsExecutableFileVersion | null> {
  const read: ByteRangeReader = (offset, length) => {
    if (offset < 0 || length <= 0 || offset + length > buffer.length) return Promise.resolve(null);
    return Promise.resolve(buffer.subarray(offset, offset + length));
  };
  return parsePeFileVersion(read, buffer.length);
}

function createFileByteRangeReader(handle: FileHandle, fileSize: number): ByteRangeReader {
  return async (offset, length) => {
    if (offset < 0 || length <= 0 || offset + length > fileSize) return null;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) return null;
    return buffer;
  };
}

// Reads the FileVersion (major.minor.build) out of a Windows PE executable's version resource.
// Opens the file read-only and never executes it. Returns `null` when the path does not exist,
// is not a regular file, or is not a well-formed PE file carrying a VS_VERSIONINFO resource —
// this function never throws.
export async function readWindowsExecutableFileVersion(
  filePath: string,
): Promise<WindowsExecutableFileVersion | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 64) return null;
    return await parsePeFileVersion(createFileByteRangeReader(handle, stats.size), stats.size);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
