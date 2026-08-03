import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { assertNativePackagingHost, verifyBundledNodeResources } from './forge.config';
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

describe('macOS auto-update signing gate', () => {
  it('enables the compiled updater only for a real signing identity', () => {
    expect(macAutoUpdateEligibleForIdentity(undefined)).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('')).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('-')).toBe(false);
    expect(macAutoUpdateEligibleForIdentity('Developer ID Application: Sprint Coder')).toBe(true);
  });
});

describe('beta release artifacts', () => {
  it('publishes every Windows and macOS auto-update artifact', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/release-beta.yml'),
      'utf8',
    );
    const ciWorkflow = readFileSync(resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
    const provisioner = readFileSync(resolve(__dirname, 'scripts/ensure-inno-setup.ps1'), 'utf8');

    expect(workflow).toContain('apps/desktop/out/make/**/*.zip');
    expect(workflow).toContain('apps/desktop/out/make/squirrel.windows/**/*.nupkg');
    expect(workflow).toContain('apps/desktop/out/make/squirrel.windows/**/RELEASES');
    expect(workflow).toContain('mac_zip_count != 1');
    expect(workflow).toContain('windows_zip_count != 1');
    expect(workflow).toContain('release-assets/RELEASES.json');
    expect(workflow).toContain('${#assets[@]} != 6');
    expect(workflow).toMatch(/release:\n[\s\S]*?- name: Checkout\n\s+uses: actions\/checkout@v7/);
    expect(workflow).toContain('run: ./apps/desktop/scripts/ensure-inno-setup.ps1');
    expect(ciWorkflow).toContain('npx electron-forge make --platform=win32 --arch=x64');
    expect(ciWorkflow).toContain("'Sprint-Coder-Installer.exe'");
    expect(ciWorkflow).toContain("'Sprint-Coder-Setup.exe'");
    expect(provisioner).toContain('choco install innosetup --version=6.7.1');
    expect(provisioner).toContain('Get-AuthenticodeSignature -LiteralPath $compiler');
    expect(provisioner).toContain("$publisher -ne 'Pyrsys B.V.'");
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
    expect(script).toContain('ArchitecturesAllowed=x64');
    expect(script).not.toContain('ArchitecturesAllowed=x64compatible');
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
