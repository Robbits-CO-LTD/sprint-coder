import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(__dirname, '../../.github/workflows/release-beta.yml'),
  'utf8',
);

describe('macOS beta release signing and notarization', () => {
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
});
