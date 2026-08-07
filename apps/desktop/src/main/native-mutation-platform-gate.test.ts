import { describe, expect, it } from 'vitest';
import { evaluateNativeMutationPlatformGate } from './native-mutation-platform-gate';
import type {
  NativeMutationDevelopmentLoadEvidence,
  NativeMutationPackagedLoadEvidence,
  NativeMutationPlatformGateInput,
} from './native-mutation-platform-gate';

const validEvidence: NativeMutationPackagedLoadEvidence = Object.freeze({
  source: 'packaged-app',
  addonPath:
    '/Applications/Sprint Coder.app/Contents/Resources/app.asar.unpacked/native-safe-fs/build/Release/sprint_coder_native_safe_fs.node',
  loadedFromUnpacked: true,
});

const validDevelopmentEvidence: NativeMutationDevelopmentLoadEvidence = Object.freeze({
  source: 'vite-dev-server',
  addonPath:
    '/Users/developer/sprint-coder/apps/desktop/native-safe-fs/build/Release/sprint_coder_native_safe_fs.node',
  loadedFromUnpacked: false,
  appPackaged: false,
  rendererUrl: 'http://127.0.0.1:5173/',
});

function validInput(): NativeMutationPlatformGateInput {
  return {
    platform: 'darwin',
    packagedLoadEvidence: validEvidence,
    probe: { available: true, capabilities: { mutation: true } },
    persistenceAuthorityAvailable: true,
  };
}

describe('evaluateNativeMutationPlatformGate', () => {
  it('allows only when every condition is satisfied', () => {
    expect(evaluateNativeMutationPlatformGate(validInput())).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it('denies when the platform is not darwin', () => {
    const result = evaluateNativeMutationPlatformGate({
      ...validInput(),
      platform: 'win32',
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('PLATFORM_NOT_DARWIN');
  });

  it('denies when packaged load evidence is null', () => {
    const result = evaluateNativeMutationPlatformGate({
      ...validInput(),
      packagedLoadEvidence: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('TRUSTED_LOAD_EVIDENCE_MISSING');
  });

  it('allows an unpackaged localhost Vite app with real native capability evidence', () => {
    expect(
      evaluateNativeMutationPlatformGate({
        ...validInput(),
        packagedLoadEvidence: null,
        developmentLoadEvidence: validDevelopmentEvidence,
      }),
    ).toEqual({ allowed: true, reasons: [] });
  });

  it('denies development evidence served from a remote renderer origin', () => {
    const result = evaluateNativeMutationPlatformGate({
      ...validInput(),
      packagedLoadEvidence: null,
      developmentLoadEvidence: {
        ...validDevelopmentEvidence,
        rendererUrl: 'https://example.com/',
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('TRUSTED_LOAD_EVIDENCE_MISSING');
  });

  it('denies development evidence that claims to be packaged', () => {
    const result = evaluateNativeMutationPlatformGate({
      ...validInput(),
      packagedLoadEvidence: null,
      developmentLoadEvidence: {
        ...validDevelopmentEvidence,
        appPackaged: true,
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('TRUSTED_LOAD_EVIDENCE_MISSING');
  });

  it('denies when packaged load evidence has the wrong source tag', () => {
    const result = evaluateNativeMutationPlatformGate({
      ...validInput(),
      packagedLoadEvidence: { ...validEvidence, source: 'dev-relative' },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('TRUSTED_LOAD_EVIDENCE_MISSING');
  });

  it('denies when packaged load evidence addonPath is empty', () => {
    const result = evaluateNativeMutationPlatformGate({
      ...validInput(),
      packagedLoadEvidence: { ...validEvidence, addonPath: '' },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('TRUSTED_LOAD_EVIDENCE_MISSING');
  });

  it('denies when packaged load evidence claims it was not loaded from unpacked', () => {
    const result = evaluateNativeMutationPlatformGate({
      ...validInput(),
      packagedLoadEvidence: { ...validEvidence, loadedFromUnpacked: false },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('TRUSTED_LOAD_EVIDENCE_MISSING');
  });

  it('denies when the probe reports unavailable', () => {
    const result = evaluateNativeMutationPlatformGate({
      ...validInput(),
      probe: { available: false, capabilities: { mutation: true } },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('PROBE_UNAVAILABLE');
  });

  it('denies when the probe reports mutation capability as false (production default)', () => {
    const result = evaluateNativeMutationPlatformGate({
      ...validInput(),
      probe: { available: true, capabilities: { mutation: false } },
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('PROBE_MUTATION_NOT_TRUE');
  });

  it('denies when persistence mutation authority is unavailable', () => {
    const result = evaluateNativeMutationPlatformGate({
      ...validInput(),
      persistenceAuthorityAvailable: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('PERSISTENCE_AUTHORITY_UNAVAILABLE');
  });

  it('lists every failing reason simultaneously rather than short-circuiting', () => {
    const result = evaluateNativeMutationPlatformGate({
      platform: 'linux',
      packagedLoadEvidence: null,
      probe: { available: false, capabilities: { mutation: false } },
      persistenceAuthorityAvailable: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual([
      'PLATFORM_NOT_DARWIN',
      'TRUSTED_LOAD_EVIDENCE_MISSING',
      'PROBE_UNAVAILABLE',
      'PROBE_MUTATION_NOT_TRUE',
      'PERSISTENCE_AUTHORITY_UNAVAILABLE',
    ]);
  });

  describe('fail-closed on malformed input', () => {
    const malformedInputs: ReadonlyArray<readonly [string, unknown]> = [
      ['null', null],
      ['undefined', undefined],
      ['a string', 'darwin'],
      ['a number', 42],
      ['an array', []],
      ['an empty object', {}],
    ];

    for (const [label, value] of malformedInputs) {
      it(`denies without throwing when the input is ${label}`, () => {
        expect(() => evaluateNativeMutationPlatformGate(value)).not.toThrow();
        expect(evaluateNativeMutationPlatformGate(value).allowed).toBe(false);
      });
    }
  });
});
