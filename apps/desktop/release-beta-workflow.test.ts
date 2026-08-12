import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/release-beta.yml'),
  'utf8',
);

describe('release signing and notarization', () => {
  it('starts platform builds after metadata while keeping draft publication behind every gate', () => {
    expect(workflow).toMatch(/  make:\n(?:.|\n)*?    needs: metadata/);
    expect(workflow).toContain(
      'needs: [metadata, validate-quality, validate-package-tests, validate-desktop-tests, make]',
    );
    expect(workflow).toContain('shard: [1/3, 2/3, 3/3]');
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
  });

  it('requires Accepted notarization and staples the app before creating DMG and ZIP files', () => {
    const submit = workflow.indexOf('xcrun notarytool submit');
    const accepted = workflow.indexOf("!= 'Accepted'");
    const staple = workflow.indexOf('xcrun stapler staple');
    const make = workflow.indexOf('npx electron-forge make --skip-package');

    expect(submit).toBeGreaterThan(-1);
    expect(accepted).toBeGreaterThan(submit);
    expect(staple).toBeGreaterThan(accepted);
    expect(make).toBeGreaterThan(staple);
  });

  it('builds unsigned Windows update assets intentionally and labels them in release notes', () => {
    expect(workflow).toContain('os: windows-2022');
    expect(workflow).toContain("SPRINT_CODER_ALLOW_UNSIGNED_WINDOWS: '1'");
    expect(workflow).toContain('./scripts/verify-unsigned-windows-release.ps1 -RenamePortableZip');
    expect(workflow).toContain('Sprint-Coder-Installer.exe');
    expect(workflow).toContain('*-full.nupkg');
    expect(workflow).toContain("-name 'RELEASES'");
    expect(workflow).toContain('Windows版はコード署名されていません');
  });

  it('normalizes cross-platform asset names before creating manifests and uploading drafts', () => {
    expect(workflow).toContain('Sprint-Coder-${RELEASE_VERSION}-arm64.dmg');
    expect(workflow).toContain('Sprint-Coder-darwin-arm64-${RELEASE_VERSION}.zip');
    expect(workflow).toContain('Sprint-Coder-linux-x64-${RELEASE_VERSION}.zip');
    expect(workflow).toContain('--json assets');
    expect(workflow).not.toContain('releases/tags/${RELEASE_TAG}');
  });

  it('resumes partial draft uploads by replacing the complete validated asset set', () => {
    const draftCheck = workflow.indexOf("Release is not a draft; refusing to replace published assets.");
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
    const publishedGuard = workflow.indexOf(
      'Release is already published; refusing to modify it.',
    );
    const existingReleaseEdit = workflow.indexOf('gh release edit "${RELEASE_TAG}"');

    expect(publishedGuard).toBeGreaterThan(-1);
    expect(existingReleaseEdit).toBeGreaterThan(publishedGuard);
  });
});
