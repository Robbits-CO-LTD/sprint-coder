import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  containsUnsafeElfLoaderPath,
  containsRelativeMachOLoaderPath,
  hasUnsafeWindowsDllImport,
  isWindowsApiSetContract,
  prepareExecutionImage,
  sealExecutablePath,
  sealedExecutableIdentityDigest,
} from './prepared-execution-image';

const identity = (digest: string) => ({
  canonicalPath: '/approved/image',
  dev: '1',
  ino: '2',
  size: 1,
  mtimeMs: 1,
  ctimeMs: 1,
  mtimeNs: '1000000',
  ctimeNs: '1000000',
  mode: 0o755,
  digest,
});

describe('sealedExecutableIdentityDigest', () => {
  it('binds side-by-side dependency digests into the approved execution identity', () => {
    const base = identity('a'.repeat(64));
    expect(sealedExecutableIdentityDigest(base)).not.toBe(
      sealedExecutableIdentityDigest({
        ...base,
        dependencies: [{ ...identity('b'.repeat(64)), canonicalPath: '/approved/helper.dll' }],
      }),
    );
  });

  it('binds the PE import name separately from the dependency canonical basename', () => {
    const base = identity('a'.repeat(64));
    const dependency = { ...identity('b'.repeat(64)), canonicalPath: '/approved/bar.dll' };
    expect(
      sealedExecutableIdentityDigest({
        ...base,
        dependencies: [{ ...dependency, importName: 'foo.dll' }],
      }),
    ).not.toBe(
      sealedExecutableIdentityDigest({
        ...base,
        dependencies: [{ ...dependency, importName: 'bar.dll' }],
      }),
    );
  });
});

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
    expect(
      hasUnsafeWindowsDllImport(
        peWithImport('ext-ms-onecore-appmodel-staterepository-cache-l1-1-0.dll'),
      ),
    ).toBe(false);
    expect(hasUnsafeWindowsDllImport(peWithImport('wpaxholder.dll'))).toBe(false);
    expect(hasUnsafeWindowsDllImport(peWithImport('hvsifiletrust.dll'))).toBe(false);
    expect(hasUnsafeWindowsDllImport(peWithImport('winspool.drv'))).toBe(false);
    expect(hasUnsafeWindowsDllImport(peWithImport('python311.dll'))).toBe(true);
  });

  it('inspects delay-load imports instead of leaving them outside the pinned dependency set', () => {
    expect(hasUnsafeWindowsDllImport(peWithImport('KERNEL32.dll', true))).toBe(false);
    expect(hasUnsafeWindowsDllImport(peWithImport('payload.dll', true))).toBe(true);
  });

  it('fails closed for malformed images', () => {
    expect(hasUnsafeWindowsDllImport(Buffer.from('not a PE'))).toBe(true);
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt('does not recurse through allowlisted imports of a System32 executable', async () => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    expect(systemRoot).toBeDefined();

    const sealed = await sealExecutablePath(join(systemRoot!, 'System32', 'where.exe'), true);

    expect(sealed.dependencies).toEqual([]);
  });

  windowsIt('launches a System32 image from its protected original directory', async () => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    expect(systemRoot).toBeDefined();
    const sealed = await sealExecutablePath(join(systemRoot!, 'System32', 'where.exe'), true);
    const prepared = await prepareExecutionImage(sealed);
    try {
      expect(prepared.launchPath).toBe(await realpath(join(systemRoot!, 'System32', 'where.exe')));
      expect(dirname(prepared.launchPath).toLocaleLowerCase()).toBe(
        (await realpath(join(systemRoot!, 'System32'))).toLocaleLowerCase(),
      );
    } finally {
      await prepared.close();
    }
  });

  windowsIt(
    'still seals an allowlisted DLL deployed beside an application executable',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'sprint-coder-system-dll-'));
      try {
        const executable = join(directory, 'command.exe');
        const dependency = join(directory, 'vcruntime140.dll');
        await writeFile(executable, peWithImport('VCRUNTIME140.dll'));
        await writeFile(dependency, peWithImport('KERNEL32.dll'));

        const sealed = await sealExecutablePath(executable);

        expect(sealed.dependencies).toEqual([
          expect.objectContaining({
            canonicalPath: await realpath(dependency),
            importName: 'vcruntime140.dll',
          }),
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  windowsIt('does not trust a System32 directory supplied through the environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sprint-coder-fake-system-root-'));
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    try {
      const fakeSystem32 = join(directory, 'System32');
      await mkdir(fakeSystem32);
      const executable = join(fakeSystem32, 'command.exe');
      const dependency = join(fakeSystem32, 'vcruntime140.dll');
      await writeFile(executable, peWithImport('VCRUNTIME140.dll'));
      await writeFile(dependency, peWithImport('KERNEL32.dll'));
      process.env.SystemRoot = directory;
      process.env.WINDIR = directory;

      const sealed = await sealExecutablePath(executable);

      expect(sealed.dependencies).toEqual([
        expect.objectContaining({
          canonicalPath: await realpath(dependency),
          importName: 'vcruntime140.dll',
        }),
      ]);
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
      if (originalWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = originalWindir;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('isWindowsApiSetContract', () => {
  it('accepts virtual API-set contracts without treating ordinary DLL names as virtual', () => {
    expect(isWindowsApiSetContract('api-ms-win-core-file-l1-1-0.dll')).toBe(true);
    expect(
      isWindowsApiSetContract('ext-ms-onecore-appmodel-staterepository-cache-l1-1-0.dll'),
    ).toBe(true);
    expect(isWindowsApiSetContract('kernel32.dll')).toBe(false);
    expect(isWindowsApiSetContract('payload.dll')).toBe(false);
  });
});

function peWithImport(name: string, delay = false): Buffer {
  const bytes = Buffer.alloc(0x400);
  bytes.write('MZ');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x0000_4550, 0x80);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional);
  if (delay) {
    bytes.writeUInt32LE(0x1080, optional + 112 + 13 * 8);
    bytes.writeUInt32LE(64, optional + 112 + 13 * 8 + 4);
  } else {
    bytes.writeUInt32LE(0x1000, optional + 120);
    bytes.writeUInt32LE(40, optional + 124);
  }
  const section = optional + 0xf0;
  bytes.writeUInt32LE(0x200, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x200, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  if (delay) {
    bytes.writeUInt32LE(1, 0x280);
    bytes.writeUInt32LE(0x10c0, 0x284);
    bytes.write(`${name}\0`, 0x2c0, 'ascii');
  } else {
    bytes.writeUInt32LE(0x1050, 0x20c);
    bytes.write(`${name}\0`, 0x250, 'ascii');
  }
  return bytes;
}

describe('containsUnsafeElfLoaderPath', () => {
  it.each(['$ORIGIN/lib', '${ORIGIN}/../lib', '/workspace/lib'])(
    'rejects ELF DT_RUNPATH %s',
    (path) => {
      expect(containsUnsafeElfLoaderPath(elfWithRunpath(path))).toBe(true);
    },
  );

  it('fails closed for malformed ELF data', () => {
    expect(containsUnsafeElfLoaderPath(Buffer.from('not an ELF'))).toBe(true);
  });

  it('allows an ELF image without RPATH or RUNPATH', () => {
    expect(containsUnsafeElfLoaderPath(elfWithRunpath())).toBe(false);
  });

  it('rejects PT_INTERP and DT_NEEDED even without a search path', () => {
    expect(containsUnsafeElfLoaderPath(elfWithRunpath(undefined, 'interpreter'))).toBe(true);
    expect(containsUnsafeElfLoaderPath(elfWithRunpath(undefined, 'needed'))).toBe(true);
  });
});

function elfWithRunpath(runpath?: string, dynamicInput?: 'interpreter' | 'needed'): Buffer {
  const bytes = Buffer.alloc(0x400);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(dynamicInput === 'interpreter' ? 3 : 2, 56);
  // PT_LOAD maps the complete file at virtual address 0x400000.
  bytes.writeUInt32LE(1, 64);
  bytes.writeBigUInt64LE(0n, 72);
  bytes.writeBigUInt64LE(0x40_0000n, 80);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
  // PT_DYNAMIC lives at file offset 0x200.
  bytes.writeUInt32LE(2, 120);
  bytes.writeBigUInt64LE(0x200n, 128);
  bytes.writeBigUInt64LE(0x40_0200n, 136);
  bytes.writeBigUInt64LE(BigInt(runpath === undefined && dynamicInput !== 'needed' ? 48 : 64), 152);
  if (dynamicInput === 'interpreter') {
    bytes.writeUInt32LE(3, 176);
    bytes.writeBigUInt64LE(0x340n, 184);
    bytes.writeBigUInt64LE(0x40_0340n, 192);
    bytes.writeBigUInt64LE(16n, 208);
  }
  writeElfDynamic(bytes, 0x200, 5, 0x40_0300); // DT_STRTAB
  writeElfDynamic(bytes, 0x210, 10, 128); // DT_STRSZ
  let terminator = 0x220;
  if (dynamicInput === 'needed') {
    writeElfDynamic(bytes, 0x220, 1, 1); // DT_NEEDED
    bytes.write('\0libpayload.so\0', 0x300, 'utf8');
    terminator = 0x230;
  }
  if (runpath !== undefined) {
    writeElfDynamic(bytes, 0x220, 29, 1); // DT_RUNPATH
    bytes.write(`\0${runpath}\0`, 0x300, 'utf8');
    terminator = 0x230;
  }
  writeElfDynamic(bytes, terminator, 0, 0);
  return bytes;
}

function writeElfDynamic(bytes: Buffer, offset: number, tag: number, value: number): void {
  bytes.writeBigUInt64LE(BigInt(tag), offset);
  bytes.writeBigUInt64LE(BigInt(value), offset + 8);
}
