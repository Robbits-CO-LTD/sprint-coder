import { describe, expect, it } from 'vitest';
import { containsRelativeMachOLoaderPath } from './prepared-execution-image';

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
