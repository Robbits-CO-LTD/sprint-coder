import { describe, expect, it } from 'vitest';
import {
  createManagedLocalManifest,
  readManagedLocalReleaseConfig,
  responseLengthMatches,
  validateArchiveEntries,
  windowsSigningOptions,
} from '../../build-managed-local-sidecar.mjs';

describe('Managed Local native build input', () => {
  it('pins one official CPU-capable release asset for every supported native host target', () => {
    const release = readManagedLocalReleaseConfig();

    expect(release).toMatchObject({
      runtime: 'llama.cpp',
      runtimeVersion: 'b10516',
      upstreamRevision: 'b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9',
      licenseSize: 1078,
      licenseSha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
    });
    expect(Object.keys(release.targets).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);
    for (const target of Object.values(release.targets)) {
      expect(target.candidateBackends).toContain('cpu');
      expect(target.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(target.archiveSize).toBeGreaterThan(10 * 1024 * 1024);
    }
  });

  it('rejects traversal, alternate roots, backslashes, and oversized archive listings', () => {
    expect(() =>
      validateArchiveEntries(
        ['llama-b10516/', 'llama-b10516/llama-server', 'llama-b10516/LICENSE'].join('\n'),
        'b10516',
        'darwin-arm64',
      ),
    ).not.toThrow();
    expect(() =>
      validateArchiveEntries(
        ['llama-server.exe', 'llama.dll', 'ggml.dll'].join('\n'),
        'b10516',
        'win32-x64',
      ),
    ).not.toThrow();
    for (const unsafe of [
      'llama-b10516/../escape',
      'different-root/llama-server',
      'llama-b10516\\llama-server',
      '/llama-b10516/llama-server',
    ])
      expect(() =>
        validateArchiveEntries(
          ['llama-b10516/', unsafe, 'llama-b10516/LICENSE'].join('\n'),
          'b10516',
          'darwin-arm64',
        ),
      ).toThrow('unsafe entry');
    expect(() =>
      validateArchiveEntries(
        ['llama-server.exe', 'nested/llama.dll', 'ggml.dll'].join('\n'),
        'b10516',
        'win32-x64',
      ),
    ).toThrow('unsafe entry');
  });

  it('uses Content-Length only for identity-encoded bytes and always relies on the final hash', () => {
    expect(responseLengthMatches(new Headers({ 'content-length': '1078' }), 1078)).toBe(true);
    expect(responseLengthMatches(new Headers({ 'content-length': '1000' }), 1078)).toBe(false);
    expect(
      responseLengthMatches(
        new Headers({ 'content-length': '1000', 'content-encoding': 'gzip' }),
        1078,
      ),
    ).toBe(true);
  });

  it('creates a deterministic manifest with server and license first and backend-bound dependencies', () => {
    const release = readManagedLocalReleaseConfig();
    const record = (name, relativePath, sha, aliasTarget) => ({
      name,
      relativePath,
      sha256: sha.repeat(64),
      byteLength: 10,
      ...(aliasTarget === undefined ? {} : { aliasTarget }),
    });

    const manifest = createManagedLocalManifest({
      release,
      target: 'darwin-arm64',
      candidateBackends: ['cpu', 'metal'],
      server: record('llama-server', 'bin/llama-server', 'a'),
      license: record('LICENSE', 'licenses/LICENSE', 'b'),
      dependencies: [
        record('libggml-metal.dylib', 'bin/libggml-metal.dylib', 'c'),
        record('libggml-cpu.dylib', 'bin/libggml-cpu.dylib', 'd'),
        record('libggml.0.dylib', 'bin/libggml.0.dylib', 'f'),
        record('libggml.dylib', 'bin/libggml.dylib', 'f', 'bin/libggml.0.dylib'),
        record('libllama.dylib', 'bin/libllama.dylib', 'e'),
      ],
    });

    expect(
      manifest.artifacts.map(({ role, path, backend, aliasTarget }) => ({
        role,
        path,
        backend,
        aliasTarget,
      })),
    ).toEqual([
      { role: 'server', path: 'bin/llama-server', backend: undefined, aliasTarget: undefined },
      { role: 'license', path: 'licenses/LICENSE', backend: undefined, aliasTarget: undefined },
      {
        role: 'runtime_dependency',
        path: 'bin/libggml-cpu.dylib',
        backend: 'cpu',
        aliasTarget: undefined,
      },
      {
        role: 'runtime_dependency',
        path: 'bin/libggml-metal.dylib',
        backend: 'metal',
        aliasTarget: undefined,
      },
      {
        role: 'runtime_dependency',
        path: 'bin/libggml.0.dylib',
        backend: undefined,
        aliasTarget: undefined,
      },
      {
        role: 'runtime_dependency',
        path: 'bin/libggml.dylib',
        backend: undefined,
        aliasTarget: 'bin/libggml.0.dylib',
      },
      {
        role: 'runtime_dependency',
        path: 'bin/libllama.dylib',
        backend: undefined,
        aliasTarget: undefined,
      },
    ]);
  });

  it('keeps Windows signing absent by default and validates configured credentials', () => {
    expect(windowsSigningOptions({})).toBeNull();
    expect(
      windowsSigningOptions({
        SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: '4f9b 4eaa cd58 21f7 e84f a525 955a 904d 5eb7 7826',
      }),
    ).toEqual({ signWithParams: '/sha1 4F9B4EAACD5821F7E84FA525955A904D5EB77826' });
    expect(() =>
      windowsSigningOptions({ SPRINT_CODER_WINDOWS_CERTIFICATE_FILE: 'certificate.pfx' }),
    ).toThrow('incomplete');
  });
});
