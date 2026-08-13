import { describe, expect, it } from 'vitest';
import {
  containsRelativeElfLoaderPath,
  containsRelativeMachOLoaderPath,
  hasUnsafeWindowsDllImport,
} from './prepared-execution-image';

describe('containsRelativeMachOLoaderPath', () => {
  it.each(['@loader_path/libX.dylib', '@executable_path/../lib/libX.dylib', '@rpath/libX.dylib'])(
    'rejects Mach-O dependency token %s',
    (token) => {
      expect(containsRelativeMachOLoaderPath(Buffer.from(`Mach-O\0${token}\0`))).toBe(true);
    },
  );

  it('does not reject an absolute dependency path', () => {
    expect(containsRelativeMachOLoaderPath(Buffer.from('/usr/lib/libSystem.B.dylib'))).toBe(false);
  });
});

describe('hasUnsafeWindowsDllImport', () => {
  it('allows system DLL imports and rejects side-by-side DLL imports', () => {
    expect(hasUnsafeWindowsDllImport(peWithImport('KERNEL32.dll'))).toBe(false);
    expect(hasUnsafeWindowsDllImport(peWithImport('python311.dll'))).toBe(true);
  });

  it('fails closed for malformed images', () => {
    expect(hasUnsafeWindowsDllImport(Buffer.from('not a PE'))).toBe(true);
  });
});

function peWithImport(name: string): Buffer {
  const bytes = Buffer.alloc(0x400);
  bytes.write('MZ');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x0000_4550, 0x80);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(0x1000, optional + 120);
  bytes.writeUInt32LE(40, optional + 124);
  const section = optional + 0xf0;
  bytes.writeUInt32LE(0x200, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x200, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  bytes.writeUInt32LE(0x1050, 0x20c);
  bytes.write(`${name}\0`, 0x250, 'ascii');
  return bytes;
}

describe('containsRelativeElfLoaderPath', () => {
  it.each(['$ORIGIN/lib', '${ORIGIN}/../lib'])('rejects ELF dependency token %s', (token) => {
    expect(containsRelativeElfLoaderPath(Buffer.from(`ELF\0${token}\0`))).toBe(true);
  });

  it('allows an absolute ELF dependency path', () => {
    expect(containsRelativeElfLoaderPath(Buffer.from('/usr/lib/libc.so'))).toBe(false);
  });
});
