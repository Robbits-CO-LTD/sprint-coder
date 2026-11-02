import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computerUseNativeManifestSchema } from '@sprint-coder/contracts';
import { parseNativeHandshake } from './computer-use-native-handshake';
import {
  computerUseNativeCompiledPin,
  computerUseNativeManifestDigest,
  parseComputerUseNativeCompiledPin,
} from './computer-use-native-provenance';
import { computerUseApprovalPathEnabled } from './computer-use-eligibility';
import { windowsDocumentViewerDeclaration } from '../../../../build-computer-use-eligibility.mjs';

const viewers = { version: 1, digest: '10adf348d184174e' };
const manifest = {
  version: 1,
  sourceCommit: 'a'.repeat(40),
  platform: 'win32',
  architecture: 'x64',
  protocolVersion: 1,
  apiVersion: 3,
  nativeVersion: 'fixture',
  moduleDigest: 'b'.repeat(64),
  binaryDigest: 'b'.repeat(64),
  signerDigest: null,
  capabilities: ['observe'],
} as const;
const handshake = { protocolVersion: 1, apiVersion: 3, napiVersion: 10, platform: 'win32' };

describe('Windows document viewer declarations', () => {
  it('carries the native constants through the build declaration, manifest, pin and handshake', () => {
    expect(windowsDocumentViewerDeclaration('win32')).toEqual({ windowsDocumentViewers: viewers });
    expect(windowsDocumentViewerDeclaration('darwin')).toEqual({});
    const parsed = computerUseNativeManifestSchema.parse({
      ...manifest,
      windowsDocumentViewers: viewers,
    });
    const pin = computerUseNativeCompiledPin(parsed);
    expect(pin).toHaveProperty('windowsDocumentViewers', viewers);
    expect(parseComputerUseNativeCompiledPin(pin)).toEqual(pin);
    expect(() =>
      parseNativeHandshake(
        { ...handshake, windowsDocumentViewers: viewers, capabilities: { approval: false } },
        'win32',
      ),
    ).not.toThrow();
    expect(computerUseNativeManifestDigest(parsed)).not.toBe(
      computerUseNativeManifestDigest(computerUseNativeManifestSchema.parse(manifest)),
    );
    const source = readFileSync(
      new URL('../../computer-use-native/computer_use_windows_host_preflight.inc', import.meta.url),
      'utf8',
    );
    expect(source).toContain('kWindowsDocumentViewerVersion');
    expect(source).toContain('kWindowsDocumentViewerDigestPinned');
    expect(source).toContain('\\"windowsDocumentViewers\\"');
    expect(source).toContain('\\"approval\\":false');
    const build = readFileSync(
      new URL('../../../../build-computer-use-native.mjs', import.meta.url),
      'utf8',
    );
    expect(build).toContain('...windowsDocumentViewerDeclaration(target)');
  });
  it('rejects Windows-only fields on every darwin declaration, including explicit undefined', () => {
    for (const value of [viewers, null, undefined]) {
      const darwin = { ...manifest, platform: 'darwin', windowsDocumentViewers: value };
      expect(computerUseNativeManifestSchema.safeParse(darwin).success).toBe(false);
      const pin = computerUseNativeCompiledPin(
        computerUseNativeManifestSchema.parse({ ...manifest, platform: 'darwin' }),
      );
      expect(() =>
        parseComputerUseNativeCompiledPin({ ...pin, windowsDocumentViewers: value }),
      ).toThrow();
      expect(() =>
        parseNativeHandshake(
          { ...handshake, platform: 'darwin', windowsDocumentViewers: value },
          'darwin',
        ),
      ).toThrow();
    }
    expect(() =>
      parseNativeHandshake(
        { ...handshake, platform: 'darwin', capabilities: { approval: false } },
        'darwin',
      ),
    ).toThrow();
  });
  it('rejects malformed viewer declarations at each parser', () => {
    const pin = computerUseNativeCompiledPin(computerUseNativeManifestSchema.parse(manifest));
    for (const value of [
      null,
      {},
      { version: 1 },
      { digest: viewers.digest },
      { ...viewers, version: 0 },
      { ...viewers, digest: 'A'.repeat(16) },
      { ...viewers, extra: 1 },
    ]) {
      expect(
        computerUseNativeManifestSchema.safeParse({ ...manifest, windowsDocumentViewers: value })
          .success,
      ).toBe(false);
      expect(() =>
        parseComputerUseNativeCompiledPin({ ...pin, windowsDocumentViewers: value }),
      ).toThrow();
      expect(() =>
        parseNativeHandshake({ ...handshake, windowsDocumentViewers: value }, 'win32'),
      ).toThrow();
    }
  });
  it('preserves the old darwin digest with and without eligibility', () => {
    for (const eligibility of [
      undefined,
      {
        mode: 'v1-allowlist',
        rulesetVersion: 1,
        classifierVersion: 1,
        lexiconVersion: 1,
        ticketRequired: true,
      },
    ]) {
      const parsed = computerUseNativeManifestSchema.parse({
        ...manifest,
        platform: 'darwin',
        ...(eligibility ? { eligibility } : {}),
      });
      const old = [
        parsed.version,
        parsed.sourceCommit,
        parsed.platform,
        parsed.architecture,
        parsed.protocolVersion,
        parsed.apiVersion,
        parsed.nativeVersion,
        parsed.moduleDigest,
        parsed.binaryDigest,
        parsed.signerDigest,
        [...parsed.capabilities].sort(),
        ...(eligibility
          ? [
              [
                eligibility.mode,
                eligibility.rulesetVersion,
                eligibility.classifierVersion,
                eligibility.lexiconVersion,
                eligibility.ticketRequired,
              ],
            ]
          : []),
      ];
      expect(computerUseNativeManifestDigest(parsed)).toBe(
        createHash('sha256').update(JSON.stringify(old), 'utf8').digest('hex'),
      );
    }
  });
  it('never advertises approval and keeps the Windows approval gate closed', () => {
    for (const approval of [true, null, 0, 'false'])
      expect(() =>
        parseNativeHandshake({ ...handshake, capabilities: { approval } }, 'win32'),
      ).toThrow();
    expect(
      computerUseApprovalPathEnabled({
        platform: 'win32',
        methodsExported: true,
        attestedClassifierVersion: 2,
        effectiveMode: 'v2-denylist',
        route: 'v2',
      }),
    ).toBe(false);
  });
});
