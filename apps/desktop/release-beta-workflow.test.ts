import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/release-beta.yml'),
  'utf8',
);
const ciWorkflow = readFileSync(resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
const unsignedWindowsVerifier = readFileSync(
  resolve(__dirname, 'scripts/verify-unsigned-windows-release.ps1'),
  'utf8',
);
const signedWindowsRelease = readFileSync(
  resolve(__dirname, '../../.agents/skills/release/scripts/release-windows.ps1'),
  'utf8',
);

describe('release signing and notarization', () => {
  it('keeps signed builds and draft publication behind the full test run of the tagged commit', () => {
    expect(workflow).toContain('needs: [metadata, tests]');
    expect(workflow).toMatch(/ {2}make:\n(?:.|\n)*? {4}needs: release-validation/);
    expect(workflow).toContain('needs: [metadata, release-validation, make]');
  });

  it('always rebuilds distributable native binaries instead of consuming CI caches', () => {
    const makeJob = workflow.slice(workflow.indexOf('\n  make:'), workflow.indexOf('\n  release:'));
    const sandboxBuild = makeJob.indexOf('npm run build:sandbox-runner');
    const macPackaging = makeJob.indexOf('npx electron-forge package');

    const desktopControlBuild = makeJob.indexOf('npm run build:desktop-control');
    const otherMake = makeJob.indexOf('run: npx electron-forge make');

    expect(sandboxBuild).toBeGreaterThan(-1);
    expect(macPackaging).toBeGreaterThan(sandboxBuild);
    // Every target runs it; it builds only where desktop control ships (Windows x64, macOS arm64).
    expect(desktopControlBuild).toBeGreaterThan(sandboxBuild);
    expect(macPackaging).toBeGreaterThan(desktopControlBuild);
    expect(otherMake).toBeGreaterThan(desktopControlBuild);
    expect(makeJob).toContain('node ../../build-better-sqlite3.mjs');
    expect(makeJob).toContain('npm run build:native-safe-fs');
    expect(makeJob).not.toContain('actions/cache');
    // The macOS job packages it too, so the build step is not limited to one runner.
    const make = (parse(workflow) as { jobs: { make: { steps: Record<string, unknown>[] } } }).jobs
      .make;
    const build = make.steps.find((step) => step.name === 'Build desktop control');
    expect(build?.run).toBe('npm run build:desktop-control');
    expect(build?.if).toBeUndefined();
  });

  it('runs the full CI test set on the tagged commit before any build (owner rule, 2026-11-15)', () => {
    // PRs and main pushes run static checks only, so this call is where every test runs.
    const release = parse(workflow) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    const tests = release.jobs.tests!;
    expect(tests.uses).toBe('./.github/workflows/ci.yml');
    expect(tests.with).toEqual({ full: true });
    expect(tests.needs).toBe('metadata');
    // No `if` on the gate chain: the tests can never be silently bypassed.
    expect(tests.if).toBeUndefined();
    expect(tests.secrets).toBeUndefined();
    // GitHub refuses a call whose nested jobs ask for more than this (ci.yml's Issue report).
    expect(tests.permissions).toEqual({ actions: 'read', contents: 'read', issues: 'write' });
    expect(release.jobs['release-validation']!.needs).toEqual(['metadata', 'tests']);
    expect(release.jobs['release-validation']!.if).toBeUndefined();
    expect(release.jobs.make!.needs).toBe('release-validation');
    expect(release.jobs.make!.if).toBeUndefined();
    // The tests are defined once, in ci.yml; the release keeps no copy of its own.
    expect(Object.keys(release.jobs).sort()).toEqual(
      ['make', 'metadata', 'release', 'release-validation', 'tests'].sort(),
    );
    expect(workflow).not.toContain('npx vitest');
    // The earlier gate looked up a main CI run; main no longer runs every test.
    expect(workflow).not.toContain('actions/workflows/ci.yml/runs');
    expect(release.jobs.metadata!.permissions).toEqual({ contents: 'read' });

    const ci = parse(ciWorkflow) as {
      on: { workflow_call: { inputs: Record<string, { type: string; required: boolean }> } };
      jobs: Record<string, { if?: string }>;
    };
    expect(ci.on.workflow_call.inputs.full).toMatchObject({ type: 'boolean', required: true });
    // `CI required` runs even when selected jobs fail or are skipped, and then fails the call.
    expect(ci.jobs.required!.if).toBe('always()');
  });

  it('accepts stable and beta tags while keeping releases as drafts', () => {
    expect(workflow).toContain("- 'v*.*.*'");
    expect(workflow).toContain("prerelease='false'");
    expect(workflow).toContain("prerelease='true'");
    expect(workflow).toContain('--prerelease="${RELEASE_PRERELEASE}"');
    expect(workflow).toContain('--draft');
  });

  it('initializes runner-temporary paths inside a step where the runner context is available', () => {
    const initializePaths = workflow.indexOf('Initialize temporary macOS signing paths');
    const signingSecrets = workflow.indexOf('secrets.MACOS_CI_KEYCHAIN_PASSWORD');

    expect(workflow).not.toContain('${{ runner.temp }}');
    expect(workflow).toContain('signing_temp_dir="${RUNNER_TEMP}/sprint-coder-signing-');
    expect(initializePaths).toBeGreaterThan(-1);
    expect(signingSecrets).toBeGreaterThan(initializePaths);
  });

  it('gates signing secrets behind an environment and a main-reachability check', () => {
    const reachability = workflow.indexOf('git merge-base --is-ancestor');
    const signingSecrets = workflow.indexOf('secrets.MACOS_CI_KEYCHAIN_PASSWORD');

    expect(workflow).toContain('environment: macos-signing');
    expect(reachability).toBeGreaterThan(-1);
    expect(signingSecrets).toBeGreaterThan(reachability);
  });

  it('uses the ROBBITS Developer ID identity without enabling ad-hoc signing', () => {
    expect(workflow).toContain(
      "MACOS_CODESIGN_IDENTITY: 'Developer ID Application: ROBBITS INC. (7TDY87Y997)'",
    );
    expect(workflow).toContain('SPRINT_CODER_CODESIGN_IDENTITY:');
    expect(workflow).not.toContain('SPRINT_CODER_ALLOW_ADHOC_CODESIGN');
  });

  it('imports temporary credentials and always removes every sensitive file', () => {
    expect(workflow).toContain('security create-keychain');
    expect(workflow).toContain('security import "${MACOS_CERTIFICATE_PATH}"');
    expect(workflow).toContain("if: always() && runner.os == 'macOS'");
    expect(workflow).toContain('security delete-keychain');
    expect(workflow).toContain('"${MACOS_CERTIFICATE_PATH}"');
    expect(workflow).toContain('"${MACOS_API_KEY_PATH}"');
    expect(workflow).toContain('"${MACOS_DMG_NOTARIZATION_RESULT}"');
  });

  it('requires Accepted notarization, staple, and Gatekeeper checks for both the app and DMG', () => {
    const appSubmit = workflow.indexOf('xcrun notarytool submit "${MACOS_NOTARIZATION_ARCHIVE}"');
    const appAccepted = workflow.indexOf('if [[ "${notarization_status}" != \'Accepted\' ]]');
    const appStaple = workflow.indexOf('xcrun stapler staple "${app_path}"');
    const appGatekeeper = workflow.indexOf(
      '/usr/sbin/spctl --assess --type execute --verbose=2 "${app_path}"',
    );
    const make = workflow.indexOf('npx electron-forge make --skip-package');
    const dmgSign = workflow.indexOf(
      '/usr/bin/codesign --force --sign "${MACOS_CODESIGN_IDENTITY}" --timestamp "${dmg_path}"',
    );
    const dmgVerify = workflow.indexOf(
      '/usr/bin/codesign --verify --strict --verbose=2 "${dmg_path}"',
    );
    const dmgSubmit = workflow.indexOf('xcrun notarytool submit "${dmg_path}"');
    const dmgAccepted = workflow.indexOf('if [[ "${dmg_notarization_status}" != \'Accepted\' ]]');
    const dmgStaple = workflow.indexOf('xcrun stapler staple "${dmg_path}"');
    const dmgGatekeeper = workflow.indexOf(
      '/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=2 "${dmg_path}"',
    );

    expect(appSubmit).toBeGreaterThan(-1);
    expect(appAccepted).toBeGreaterThan(appSubmit);
    expect(appStaple).toBeGreaterThan(appAccepted);
    expect(appGatekeeper).toBeGreaterThan(appStaple);
    expect(make).toBeGreaterThan(appGatekeeper);
    expect(dmgSign).toBeGreaterThan(make);
    expect(dmgVerify).toBeGreaterThan(dmgSign);
    expect(dmgSubmit).toBeGreaterThan(dmgVerify);
    expect(dmgAccepted).toBeGreaterThan(dmgSubmit);
    expect(dmgStaple).toBeGreaterThan(dmgAccepted);
    expect(dmgGatekeeper).toBeGreaterThan(dmgStaple);
  });

  it('builds unsigned Windows update assets intentionally and labels them in release notes', () => {
    expect(workflow).toContain('os: windows-2022');
    expect(workflow).toContain("SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS: '1'");
    expect(workflow).toContain('./scripts/verify-unsigned-windows-release.ps1 -RenamePortableZip');
    expect(workflow).toContain('Sprint-Coder-Installer-*.exe');
    expect(workflow).toContain('*-full.nupkg');
    expect(workflow).toContain("-name 'RELEASES'");
    expect(workflow).toContain('Windows版はコード署名されていません');
  });

  it('keeps the installer version in signed and unsigned release paths and download links', () => {
    expect(unsignedWindowsVerifier).toContain('Sprint-Coder-Installer-$version.exe');
    expect(signedWindowsRelease).toContain(
      '$installerName = "Sprint-Coder-Installer-$version.exe"',
    );
    expect(signedWindowsRelease).toContain('Join-Path $stagingDirectory $installerName');
    expect(signedWindowsRelease).toContain(']($baseUrl/$installerName)');
    expect(workflow).toContain('*/Sprint-Coder-Installer-"${RELEASE_VERSION}".exe)');
    expect(workflow).toContain('-name "Sprint-Coder-Installer-${RELEASE_VERSION}.exe" -o');
    expect(workflow).toContain('](${base_url}/Sprint-Coder-Installer-${RELEASE_VERSION}.exe)');
    for (const source of [workflow, unsignedWindowsVerifier, signedWindowsRelease])
      expect(source).not.toContain('Sprint-Coder-Installer.exe');
  });

  it('uses the Squirrel-normalized NuGet version for stable and beta Windows update packages', () => {
    for (const script of [unsignedWindowsVerifier, signedWindowsRelease]) {
      expect(script).toContain("require('electron-winstaller').convertVersion(process.argv[1])");
      expect(script).toContain('SprintCoder-$($nugetVersion.Trim())-full.nupkg');
      expect(script).not.toContain('SprintCoder-$version-full.nupkg');
    }
  });

  it('normalizes cross-platform asset names before creating manifests and uploading drafts', () => {
    expect(workflow).toContain('Sprint-Coder-${RELEASE_VERSION}-arm64.dmg');
    expect(workflow).toContain('Sprint-Coder-darwin-arm64-${RELEASE_VERSION}.zip');
    expect(workflow).toContain('Sprint-Coder-linux-x64-${RELEASE_VERSION}.zip');
    expect(workflow).toContain('--json assets');
    expect(workflow).not.toContain('releases/tags/${RELEASE_TAG}');
  });

  it('resumes partial draft uploads by replacing the complete validated asset set', () => {
    const draftCheck = workflow.indexOf(
      'Release is not a draft; refusing to replace published assets.',
    );
    const tagCheck = workflow.indexOf(
      'Release tag targets ${tag_commit}, expected ${expected_commit}.',
    );
    const upload = workflow.indexOf('gh release upload "${RELEASE_TAG}" "${assets[@]}"');

    expect(draftCheck).toBeGreaterThan(-1);
    expect(tagCheck).toBeGreaterThan(draftCheck);
    expect(upload).toBeGreaterThan(tagCheck);
    expect(workflow).toContain('--clobber');
    expect(workflow).toContain('legacy_asset_names=()');
    expect(workflow).toContain('gh api --method DELETE "${legacy_asset_endpoint}"');
    expect(workflow).toContain('Legacy release asset ${legacy_asset_name} was not removed.');
    expect(workflow).toContain('Expected exactly one uploaded release asset named');
  });

  it('validates the tag commit and replaces its managed release-notes section on reruns', () => {
    expect(workflow).toContain('commits/${RELEASE_TAG}');
    expect(workflow).toContain('git rev-parse "${GITHUB_SHA}^{commit}"');
    expect(workflow).not.toContain('targetCommitish');
    expect(workflow).toContain('<!-- sprint-coder-packages:start -->');
    expect(workflow).toContain('<!-- sprint-coder-packages:end -->');
    expect(workflow).toContain('$0 == managed_start { managed = 1; next }');
  });

  it('refuses to turn an existing published release back into a draft', () => {
    const publishedGuard = workflow.indexOf('Release is already published; refusing to modify it.');
    const existingReleaseEdit = workflow.indexOf('gh release edit "${RELEASE_TAG}"');

    expect(publishedGuard).toBeGreaterThan(-1);
    expect(existingReleaseEdit).toBeGreaterThan(publishedGuard);
  });
});
