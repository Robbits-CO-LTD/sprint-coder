import { describe, expect, it } from 'vitest';
import {
  computerAppGrantCodeChanged,
  computerAppGrantIdentityFrom,
  computerAppGrantIdentityMatches,
  computerAppGrantMismatch,
  normalizeExecutablePath,
  type ComputerAppGrantIdentity,
} from './computer-use-grant-identity';

function macIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: 'darwin',
    identityDigest: 'a'.repeat(64),
    bundleId: 'com.example.notes',
    executablePath: '/Applications/Notes.app/Contents/MacOS/Notes',
    executableDigest: 'b'.repeat(64),
    teamId: 'TEAMID1234',
    signingIdentifier: 'com.example.notes',
    cdHash: 'c'.repeat(64),
    displayName: 'Notes',
    ...overrides,
  };
}

function winIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: 'win32',
    identityDigest: 'a'.repeat(64),
    executablePath: 'C:\\Program Files\\Example\\Notes.exe',
    executableDigest: 'b'.repeat(64),
    signerDigest: 'd'.repeat(64),
    packageFamilyName: null,
    appUserModelId: null,
    displayName: 'Notes',
    ...overrides,
  };
}

function derive(identity: Record<string, unknown>): ComputerAppGrantIdentity {
  const derived = computerAppGrantIdentityFrom(identity);
  expect(derived).not.toBeNull();
  return derived!;
}

describe('grant identity derivation', () => {
  it('binds a signed macOS application to its bundle id, Team ID, and signing identifier', () => {
    const base = derive(macIdentity());
    expect(base.identityKind).toBe('verified-signed');
    expect(base.appId).toBe('com.example.notes');
    expect(base.publisher).toBe('TEAMID1234');
    for (const change of [
      { bundleId: 'com.example.other' },
      { teamId: 'OTHERTEAM1' },
      { signingIdentifier: 'com.example.other' },
    ])
      expect(derive(macIdentity(change)).grantIdentityDigest).not.toBe(base.grantIdentityDigest);
  });

  it('keeps a signed macOS grant across an ordinary update, and only across that', () => {
    const base = derive(macIdentity());
    // An update moves the code, never the signer: the ADR's whole point is not to re-ask for this.
    const updated = derive(
      macIdentity({ executableDigest: 'e'.repeat(64), cdHash: 'f'.repeat(64) }),
    );
    expect(computerAppGrantIdentityMatches(base, updated)).toBe(true);
    expect(computerAppGrantCodeChanged(base, updated)).toBe(true);
    // A same-name application somewhere else is a different application (§6.3).
    const moved = derive(
      macIdentity({ executablePath: '/Users/x/Downloads/Notes.app/Contents/MacOS/Notes' }),
    );
    expect(computerAppGrantIdentityMatches(base, moved)).toBe(false);
    expect(computerAppGrantMismatch(base, moved, false)).toBe('identity_changed');
  });

  it('never forges an attribute this installation cannot verify', () => {
    // V1 resolves a Windows signer by digest only, so there is no publisher common name to show.
    expect(derive(winIdentity()).publisher).toBeNull();
    // A macOS application with no signing facts is unverified, not "signed with a null Team ID".
    const unsigned = derive(macIdentity({ teamId: null, signingIdentifier: null }));
    expect(unsigned.identityKind).toBe('unverified');
    expect(unsigned.publisher).toBeNull();
    expect(derive(macIdentity()).grantIdentityDigest).not.toBe(unsigned.grantIdentityDigest);
    // "Not observed" must not hash like an application that literally spells its Team ID "null".
    expect(derive(macIdentity({ teamId: null })).grantIdentityDigest).not.toBe(
      derive(macIdentity({ teamId: 'null' })).grantIdentityDigest,
    );
    // Nor may content move between adjacent fields without changing the digest: an application
    // chooses its own bundle id, so unprefixed concatenation would let it choose a collision.
    expect(
      derive(macIdentity({ bundleId: 'com.example.note', teamId: 'sTEAMID12' }))
        .grantIdentityDigest,
    ).not.toBe(
      derive(macIdentity({ bundleId: 'com.example.notes', teamId: 'TEAMID12' }))
        .grantIdentityDigest,
    );
  });

  it('separates a Windows package identity from a Win32 image identity', () => {
    const image = derive(winIdentity());
    const packaged = derive(winIdentity({ packageFamilyName: 'Example.Notes_8wekyb3d8bbwe' }));
    expect(image.grantIdentityDigest).not.toBe(packaged.grantIdentityDigest);
    expect(image.appId).toBe('notes.exe');
    expect(packaged.appId).toBe('Example.Notes_8wekyb3d8bbwe');
    // A Win32 identity is the signer plus where the image lives, so the same signer elsewhere is a
    // different grant.
    const elsewhere = derive(winIdentity({ executablePath: 'C:\\Users\\x\\Downloads\\Notes.exe' }));
    expect(elsewhere.grantIdentityDigest).not.toBe(image.grantIdentityDigest);
    // A package identity does not include the path, so a servicing update keeps the grant.
    expect(
      derive(
        winIdentity({
          packageFamilyName: 'Example.Notes_8wekyb3d8bbwe',
          executablePath: 'C:\\Program Files\\WindowsApps\\Example.Notes_2.0\\Notes.exe',
        }),
      ).grantIdentityDigest,
    ).toBe(packaged.grantIdentityDigest);
  });

  it('keeps a Windows package grant across a servicing update, and only for packages', () => {
    // `WindowsApps\<PackageFullName>_<version>_<arch>__<publisherId>\` puts the version in the
    // directory name, so comparing the path would re-ask for permission on every Store update.
    const packaged = derive(
      winIdentity({
        packageFamilyName: 'Example.Notes_8wekyb3d8bbwe',
        executablePath:
          'C:\\Program Files\\WindowsApps\\Example.Notes_1.0.0.0_x64__8wekyb3d8bbwe\\Notes.exe',
      }),
    );
    const updated = derive(
      winIdentity({
        packageFamilyName: 'Example.Notes_8wekyb3d8bbwe',
        executablePath:
          'C:\\Program Files\\WindowsApps\\Example.Notes_1.1.0.0_x64__8wekyb3d8bbwe\\Notes.exe',
        // A signed application's executable bytes move on every update and are not compared.
        executableDigest: 'f'.repeat(64),
      }),
    );
    expect(computerAppGrantMismatch(packaged, updated, false)).toBeNull();
    expect(computerAppGrantIdentityMatches(packaged, updated)).toBe(true);
    // A different signer is still a different application, path or no path.
    expect(
      computerAppGrantMismatch(
        packaged,
        derive(
          winIdentity({
            packageFamilyName: 'Example.Notes_8wekyb3d8bbwe',
            signerDigest: 'e'.repeat(64),
          }),
        ),
        false,
      ),
    ).toBe('identity_changed');
    // The other direction: a plain Win32 image keeps the path comparison, because "the same signer
    // in a different directory" really is a different application there.
    const image = derive(winIdentity());
    expect(
      computerAppGrantMismatch(
        { ...image, executablePath: 'c:\\program files\\example\\moved\\notes.exe' },
        image,
        false,
      ),
    ).toBe('identity_changed');
    // And an unsigned Windows application, whose identity is the path and the bytes.
    const unsigned = derive(winIdentity({ signerDigest: null }));
    expect(
      computerAppGrantMismatch(
        { ...unsigned, executablePath: 'c:\\other\\notes.exe' },
        unsigned,
        false,
      ),
    ).toBe('identity_changed');
  });

  it('binds an unsigned application to its executable bytes', () => {
    const base = derive(macIdentity({ teamId: null, signingIdentifier: null }));
    const rebuilt = derive(
      macIdentity({ teamId: null, signingIdentifier: null, executableDigest: 'e'.repeat(64) }),
    );
    // The digest is part of the identity for unverified apps, so this is not even the same identity.
    expect(rebuilt.grantIdentityDigest).not.toBe(base.grantIdentityDigest);
    expect(computerAppGrantMismatch(base, rebuilt, false)).toBe('identity_changed');
    // And a stored record that somehow lost its digest must not match anything.
    expect(computerAppGrantMismatch({ ...base, executableDigest: null }, base, false)).toBe(
      'executable_changed',
    );
    // A signed application's digest moving is not a mismatch; an unsigned one's is the mismatch.
    expect(computerAppGrantCodeChanged(base, rebuilt)).toBe(false);
  });

  it('refuses to derive an identity it cannot pin down', () => {
    expect(computerAppGrantIdentityFrom(null)).toBeNull();
    expect(computerAppGrantIdentityFrom('/Applications/Notes.app')).toBeNull();
    expect(computerAppGrantIdentityFrom(macIdentity({ platform: 'linux' }))).toBeNull();
    expect(computerAppGrantIdentityFrom(macIdentity({ executablePath: '' }))).toBeNull();
    // Signed but with no bundle id, and unsigned with no executable digest: both would produce a
    // digest that another application could also produce.
    expect(computerAppGrantIdentityFrom(macIdentity({ bundleId: null }))).toBeNull();
    expect(
      computerAppGrantIdentityFrom(
        macIdentity({ teamId: null, signingIdentifier: null, executableDigest: null }),
      ),
    ).toBeNull();
    expect(
      computerAppGrantIdentityFrom(winIdentity({ signerDigest: null, executableDigest: null })),
    ).toBeNull();
  });

  it('orders revocation ahead of re-confirmation', () => {
    const base = derive(macIdentity());
    // A newly denied class is revoked outright, never turned into another card to approve, even
    // when the identity itself is unchanged.
    expect(computerAppGrantMismatch(base, base, true)).toBe('denied_class');
    expect(computerAppGrantMismatch(base, base, false)).toBeNull();
    const unsigned = derive(macIdentity({ teamId: null, signingIdentifier: null }));
    expect(computerAppGrantMismatch(base, unsigned, false)).toBe('signing_class_changed');
  });

  it('gives one spelling per path so a grant is not defeated by punctuation', () => {
    expect(normalizeExecutablePath('darwin', ' /Applications//Notes.app/ ')).toBe(
      '/Applications/Notes.app',
    );
    expect(normalizeExecutablePath('win32', 'C:/Program Files\\\\Example\\Notes.exe')).toBe(
      'c:\\program files\\example\\notes.exe',
    );
    expect(normalizeExecutablePath('win32', '\\\\server\\share\\Notes.exe')).toBe(
      '\\\\server\\share\\notes.exe',
    );
    // macOS keeps its case: a case-sensitive volume makes two spellings two different files.
    expect(normalizeExecutablePath('darwin', '/Applications/Notes')).not.toBe(
      normalizeExecutablePath('darwin', '/applications/notes'),
    );
  });
});
