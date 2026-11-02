import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

export const windowsHostNativeDirectory = fileURLToPath(
  new URL('./apps/desktop/computer-use-native/', import.meta.url),
);

export function readWindowsHostSource(directory = windowsHostNativeDirectory) {
  const read = (name) => {
    const source = readFileSync(join(directory, name), 'utf8');
    if (source.includes('\r')) throw new Error(`CR in Windows host source: ${name}`);
    return source;
  };
  const included = new Set();
  const host = read('computer_use_windows_host.cc');
  // Consume the include's newline as well: each fragment carries its original line endings.
  const expanded = host.replace(
    /^#include "(computer_use_windows_host_[a-z0-9_]+\.inc)"(?:\n|$)/gmu,
    (_line, name) => {
      if (included.has(name)) throw new Error(`Duplicate Windows host include: ${name}`);
      included.add(name);
      const source = read(name);
      if (source.includes('#include "computer_use_windows_host_'))
        throw new Error(`Nested Windows host include: ${name}`);
      if (!source.endsWith('\n')) throw new Error(`Missing final newline: ${name}`);
      return source;
    },
  );
  for (const name of readdirSync(directory)) {
    if (/^computer_use_windows_host_.*\.inc$/u.test(name) && !included.has(name))
      throw new Error(`Unreferenced Windows host fragment: ${name}`);
  }
  return expanded;
}
