import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { shouldIgnoreFromPackage } from '../../../forge.config';

const fixtureRoot = __dirname;
const source = readFileSync(resolve(fixtureRoot, 'win32_acceptance_fixture.cc'), 'utf8');
const contract = readFileSync(resolve(fixtureRoot, 'fixture_contract.h'), 'utf8');
const buildScript = readFileSync(resolve(fixtureRoot, 'build.ps1'), 'utf8');

describe('deterministic Win32 Computer Use acceptance fixture', () => {
  it('publishes a stable title and unique control IDs for safe and boundary targets', () => {
    expect(contract).toContain('Sprint Coder Computer Use Fixture v1');
    const ids = [...contract.matchAll(/k[A-Za-z]+\s*=\s*(\d+)/gu)].map((match) => Number(match[1]));
    expect(ids).toEqual([
      1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1101, 1102, 1103, 1104, 1105,
      1201, 1202,
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses standard Win32 controls for normal, secure, high-impact, and file-picker paths', () => {
    expect(source).toContain('ES_PASSWORD');
    expect(source).toContain('Authorize test payment — MUST BLOCK');
    expect(source).toContain('GetOpenFileNameW');
    expect(source).toContain('OFN_DONTADDTORECENT');
    expect(source).toContain('SprintCoderComputerUseSafeDialogV1');
    expect(source).toContain('EnableWindow(owner, FALSE)');
    expect(source).toContain('Open same-owner safe dialog');
    expect(source).toContain('selection intentionally not displayed or stored');
    expect(source).toContain('--contract-check');
  });

  it('builds only as x64 into an explicit temporary output and is excluded from packages', () => {
    expect(buildScript).toContain('$machine -ne 0x8664');
    expect(buildScript).toContain('/SUBSYSTEM:WINDOWS,10.00');
    expect(buildScript).toContain('/MANIFESTINPUT:');
    expect(
      shouldIgnoreFromPackage(
        '/computer-use-native/fixtures/win32-acceptance/sprint-coder-computer-use-fixture.exe',
      ),
    ).toBe(true);
    expect(config.packagerConfig?.extraResource ?? []).not.toContain(
      resolve(fixtureRoot, 'sprint-coder-computer-use-fixture.exe'),
    );
  });
});
