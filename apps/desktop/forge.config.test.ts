import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, {
  assertNativePackagingHost,
  resolveWindowsSignOptions,
  verifyBundledNodeResources,
} from './forge.config';
import { macAutoUpdateEligibleForIdentity } from './vite.main.config';
import {
  planWindowsWizardInstaller,
  SQUIRREL_SETUP_EXE,
  WINDOWS_WIZARD_INSTALLER_EXE,
} from './windows-wizard-installer';

describe('desktop package icon', () => {
  it('points Electron Packager at real macOS and Windows icon files', () => {
    const iconPath = resolve(__dirname, 'assets', 'sprint-coder-icon');

    expect(config.packagerConfig?.icon).toBe(iconPath);
    expect(existsSync(`${iconPath}.icns`)).toBe(true);
    expect(existsSync(`${iconPath}.ico`)).toBe(true);
    expect(readFileSync(`${iconPath}.icns`).subarray(0, 4).toString('ascii')).toBe('icns');
    expect([...readFileSync(`${iconPath}.ico`).subarray(0, 4)]).toEqual([0, 0, 1, 0]);
  });
});

describe('native package target', () => {
  it('rejects cross-platform packages before Forge can emit an incomplete artifact', () => {
    const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';

    expect(() => assertNativePackagingHost(process.platform)).not.toThrow();
    expect(() => assertNativePackagingHost(otherPlatform)).toThrow(
      'Cross-platform packaging is unsupported',
    );
  });

  it.runIf(process.platform === 'win32')(
    'accepts only the pinned signed Node executable used by Windows packages',
    () => {
      expect(() => verifyBundledNodeResources()).not.toThrow();
    },
  );
});

describe('Windows release signing', () => {
  it('selects a LocalMachine code-signing certificate without exporting its private key', () => {
    expect(
      resolveWindowsSignOptions({
        SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: '4f9b 4eaa cd58 21f7 e84f a525 955a 904d 5eb7 7826',
      }),
    ).toEqual({
      signWithParams: ['/sha1', '4F9B4EAACD5821F7E84FA525955A904D5EB77826', '/sm'],
      description: 'Sprint Coder',
    });
  });

  it('rejects malformed store thumbprints and incomplete PFX settings', () => {
    expect(() =>
      resolveWindowsSignOptions({ SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: 'not-a-thumbprint' }),
    ).toThrow('40-character SHA-1 thumbprint');
    expect(() =>
      resolveWindowsSignOptions({ SPRINT_CODER_WINDOWS_CERTIFICATE_FILE: 'release.pfx' }),
    ).toThrow('must be provided together');
    expect(() =>
      resolveWindowsSignOptions({
        SPRINT_CODER_WINDOWS_CERTIFICATE_FILE: 'release.pfx',
        SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD: 'secret',
        SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: 'not-a-thumbprint',
      }),
    ).toThrow('40-character SHA-1 thumbprint');
    expect(() =>
      resolveWindowsSignOptions({
        SPRINT_CODER_WINDOWS_CERTIFICATE_FILE: 'release.pfx',
        SPRINT_CODER_WINDOWS_CERTIFICATE_PASSWORD: 'secret',
        SPRINT_CODER_WINDOWS_CERTIFICATE_SHA1: '4F9B4EAACD5821F7E84FA525955A904D5EB77826',
      }),
    ).toThrow('mutually exclusive');
  });
});

describe('macOS auto-update signing gate', () => {
  it('enables the compiled updater only for a real signing identity', () => {
    expect(macAutoUpdateEligibleForIdentity(undefined)).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('')).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('-')).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('Developer ID Application: Sprint Coder')).toBe(true);
  });
});

describe('beta release artifacts', () => {
  it('builds macOS and Ubuntu artifacts in Actions and leaves Windows for local signing', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/release-beta.yml'),
      'utf8',
    );
    const ciWorkflow = readFileSync(resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
    const provisioner = readFileSync(resolve(__dirname, 'scripts/ensure-inno-setup.ps1'), 'utf8');

    expect(workflow).toContain('apps/desktop/out/make/**/*.zip');
    expect(workflow).toContain('os: macos-latest');
    expect(workflow).toContain('os: ubuntu-latest');
    expect(workflow).not.toContain('os: windows-2022');
    expect(workflow).toContain('mac_zip_count != 1');
    expect(workflow).toContain('linux_zip_count != 1');
    expect(workflow).toContain('release-assets/RELEASES.json');
    expect(workflow).toContain('${#assets[@]} != 3');
    expect(workflow).toContain('--prerelease');
    expect(workflow).toContain('--draft');
    expect(readFileSync(resolve(__dirname, 'forge.config.ts'), 'utf8')).toContain(
      "new MakerZIP({}, ['darwin', 'linux', 'win32'])",
    );
    expect(workflow).toMatch(/release:\n[\s\S]*?- name: Checkout\n\s+uses: actions\/checkout@v7/);
    expect(ciWorkflow).toContain('npx electron-forge make --platform=win32 --arch=x64');
    expect(ciWorkflow).toContain("'Sprint-Coder-Installer.exe'");
    expect(ciWorkflow).toContain("'Sprint-Coder-Setup.exe'");
    expect(provisioner).toContain('choco install innosetup --version=6.7.1');
    expect(provisioner).toContain('Get-AuthenticodeSignature -LiteralPath $compiler');
    expect(provisioner).toContain("$publisher -ne 'Pyrsys B.V.'");
    expect(provisioner).toContain(
      '4EFD84E6F1091B19321231743B9AA86482EFFD6D0BEA9F7A44DB6211154616F3',
    );
  });

  it('wraps the Squirrel bootstrapper in a localized Windows setup wizard', () => {
    const script = readFileSync(resolve(__dirname, 'installer/windows-wizard.iss'), 'utf8');
    const sourceSetupPath = resolve('out/make/squirrel.windows/x64', SQUIRREL_SETUP_EXE);
    const plan = planWindowsWizardInstaller([
      {
        platform: 'win32',
        arch: 'x64',
        packageJSON: { version: '0.0.1-beta.5' },
        artifacts: [sourceSetupPath, resolve('out/make/squirrel.windows/x64/RELEASES')],
      },
    ]);

    expect(plan).toMatchObject({
      sourceSetupPath,
      outputPath: resolve('out/make/squirrel.windows/x64', WINDOWS_WIZARD_INSTALLER_EXE),
      version: '0.0.1-beta.5',
    });
    expect(script).toContain('WizardStyle=modern');
    expect(script).toContain('DisableWelcomePage=no');
    expect(script).toContain('DisableReadyPage=no');
    expect(script).toContain('DisableFinishedPage=no');
    expect(script).toContain('compiler:Languages\\Japanese.isl');
    expect(script).toContain('#if VER >= EncodeVer(6,3,0)');
    expect(script).toContain('ArchitecturesAllowed=x64compatible');
    expect(script).toContain('#else\nArchitecturesAllowed=x64');
    expect(script).toContain('AfterInstall: InstallSprintCoder');
    expect(script).toContain(
      "Exec(Bootstrapper, '--silent', ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode)",
    );
    expect(script).toContain('if ResultCode <> 0 then');
    expect(script).toContain('RaiseException');
    expect(script).toContain('Parameters: "--processStart ""Sprint Coder.exe"""; Description:');
    expect(script).toContain('Flags: nowait postinstall skipifsilent skipifdoesntexist');
  });

  it('generates a Squirrel.Mac manifest that targets the release ZIP', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'sprint-coder-update-'));
    try {
      const zipPath = resolve(directory, 'Sprint-Coder-darwin-arm64-0.0.1-beta.5.zip');
      const outputPath = resolve(directory, 'RELEASES.json');
      writeFileSync(zipPath, 'fixture');
      execFileSync(process.execPath, [
        resolve(__dirname, 'scripts/create-macos-update-manifest.mjs'),
        '--version',
        '0.0.1-beta.5',
        '--tag',
        'v0.0.1-beta.5',
        '--repository',
        'Robbits-CO-LTD/sprint-coder',
        '--zip',
        zipPath,
        '--output',
        outputPath,
      ]);

      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
        currentRelease: '0.0.1-beta.5',
        releases: [
          {
            version: '0.0.1-beta.5',
            updateTo: {
              version: '0.0.1-beta.5',
              url: 'https://github.com/Robbits-CO-LTD/sprint-coder/releases/download/v0.0.1-beta.5/Sprint-Coder-darwin-arm64-0.0.1-beta.5.zip',
            },
          },
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
