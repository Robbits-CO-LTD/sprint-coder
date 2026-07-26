import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

/** Resolves Electron's actual platform executable instead of the POSIX-only `.bin/electron` shim. */
export function electronTestExecutablePath(): string {
  const executable = requireFromHere('electron') as unknown;
  if (typeof executable !== 'string')
    throw new Error('The Electron package did not resolve to an executable path');
  return executable;
}
