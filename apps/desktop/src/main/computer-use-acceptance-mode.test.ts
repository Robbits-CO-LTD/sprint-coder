import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeAcceptanceBuildHeader } from '../../../../build-computer-use-acceptance.mjs';
import { computerUseAcceptanceBuildForEnv } from '../../computer-use-acceptance-build';
import { computerUseCompiledAcceptanceMode } from './computer-use-acceptance-mode';

const read = (path: string) => readFileSync(join(__dirname, '../../../..', path), 'utf8');
const native = 'apps/desktop/computer-use-native/';
const flag = 'SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD';
const mode = 'windows-unsigned-acceptance';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Windows native acceptance build (#988 N7-4)', () => {
  it.each([undefined, '', mode, '1', 'true', 'false', ` ${mode}`, `${mode} `])(
    'matches Main build validation for %s on every platform',
    (value) => {
      for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const environment = { [flag]: value };
        if (value !== undefined && value !== '' && (value !== mode || platform !== 'win32')) {
          expect(() => computerUseAcceptanceBuildForEnv(environment, platform)).toThrow();
          expect(() => nativeAcceptanceBuildHeader(environment, platform)).toThrow();
          continue;
        }
        const compiled = computerUseAcceptanceBuildForEnv(environment, platform);
        expect(nativeAcceptanceBuildHeader(environment, platform)).toBe(
          `#pragma once\n#define ${flag} ${compiled === null ? 0 : 1}\n`,
        );
        vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD__', compiled);
        expect(computerUseCompiledAcceptanceMode()).toBe(compiled?.mode ?? null);
      }
    },
  );

  it('runtime environment cannot promote or demote the compiled mode', () => {
    for (const compiled of [null, computerUseAcceptanceBuildForEnv({ [flag]: mode }, 'win32')]) {
      vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD__', compiled);
      for (const runtimeValue of ['', mode, 'true']) {
        vi.stubEnv(flag, runtimeValue);
        expect(computerUseCompiledAcceptanceMode()).toBe(compiled?.mode ?? null);
      }
    }
  });

  it('acceptance_mode_is_build_bound_across_all_target_paths', () => {
    const facts = read(`${native}computer_use_windows_host_target_facts.inc`);
    const targets = read(`${native}computer_use_windows_host_v2_targets.inc`);
    expect(facts).toContain('#ifndef SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD');
    expect(facts).toContain('#define SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD 0');
    expect(facts).toContain(
      'inline constexpr bool kWindowsTargetAcceptanceMode =\n    SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD == 1;',
    );
    expect(facts).toContain('facts.acceptance_fixture =\n        kWindowsTargetAcceptanceMode &&');
    expect(facts).not.toContain('acceptance_mode');
    expect(targets).not.toContain('acceptance_mode');
    // List, rejudge, list candidate, new start and existing start all use the same context.
    expect(targets.match(/CurrentWindowsTargetFactsContext\(/gu)).toHaveLength(5);
    expect(
      targets.match(
        /CurrentWindowsTargetFactsContext\(windows_v2_main_pid,\s*WindowsV2SelfSignerThumbprint\(\)\)/gu,
      ),
    ).toHaveLength(1);
    expect(
      targets.match(
        /CurrentWindowsTargetFactsContext\(\s*windows_v2_main_pid, WindowsV2SelfSignerThumbprint\(\), context_valid\)/gu,
      ),
    ).toHaveLength(1);
    expect(
      targets.match(
        /CurrentWindowsTargetFactsContext\(work.main_pid, std::move\(signer\),\s*still_valid\)/gu,
      ),
    ).toHaveLength(1);
    expect(
      targets.match(
        /CurrentWindowsTargetFactsContext\(input.main_pid, WindowsV2SelfSignerThumbprint\(\),\s*still_valid\)/gu,
      ),
    ).toHaveLength(1);
    expect(
      targets.match(
        /CurrentWindowsTargetFactsContext\(input.main_pid, std::move\(signer\),\s*still_valid\)/gu,
      ),
    ).toHaveLength(1);
    expect(facts.match(/kWindowsTargetAcceptanceMode/gu)).toHaveLength(2);
    const build = read('build-computer-use-native.mjs');
    expect(build).toContain('nativeAcceptanceBuildHeader(process.env, target)');
    expect(build).toContain(
      'writeFileSync(acceptanceHeader, acceptanceBuildHeader, { mode: 0o600 })',
    );
    expect(build).toContain('`/FI${acceptanceHeader}`');
    expect(build.indexOf('writeFileSync(acceptanceHeader')).toBeLessThan(
      build.indexOf('run(compiler'),
    );
  });
});
