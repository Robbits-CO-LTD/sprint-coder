import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const nativeDirectory = join(__dirname, '../../computer-use-native');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
type Build = Readonly<{
  wrap: (arguments_: string[]) => { file: string; args: string[]; verbatim: boolean };
}>;

// The same MSVC discovery as the *-component tests: cl.exe on PATH, else vcvars64 from vswhere.
function findBuild(): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { wrap: (args) => ({ file: 'cl.exe', args, verbatim: false }) };
  if (!existsSync(vswhere)) return null;
  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  );
  const root = found.stdout.trim();
  const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (found.status !== 0 || root === '' || !existsSync(vcvars)) return null;
  return {
    wrap: (args) => ({
      file: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        `"call "${vcvars}" >nul && cl.exe ${args.map((argument) => `"${argument}"`).join(' ')}"`,
      ],
      verbatim: true,
    }),
  };
}

const finalDeclaration = [
  'FROM_BUILD=1',
  'V2=1',
  'RULESET_VERSION=4',
  'CLASSIFIER_VERSION=2',
  'LEXICON_VERSION=3',
  'TICKET_REQUIRED=1',
  'INTERLOCK_ENFORCED=1',
].map((definition) => '/DSPRINT_CODER_ELIGIBILITY_' + definition);
const diagnostic =
  '#988 P5b requires an Explorer pre-send hook after SendInputForBoundTarget revalidation';

describe.skipIf(process.platform !== 'win32')(
  'Windows production eligibility compile guard',
  () => {
    it('rejects the final production declaration and accepts current and isolated acceptance builds', () => {
      const build = findBuild();
      expect(build, 'cl.exe (MSVC) is required').not.toBeNull();
      if (!build) throw new Error('MSVC unavailable');
      const directory = mkdtempSync(join(tmpdir(), 'sc-eligibility-build-'));
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected temporary path');
      try {
        const unit = join(directory, 'guard.cc');
        writeFileSync(unit, '#include "computer_use_windows_target_facts.h"\n');
        const compile = (definitions: string[]) => {
          const command = build.wrap([
            '/nologo',
            '/std:c++20',
            '/EHsc',
            '/W4',
            '/sdl',
            '/c',
            '/I' + nativeDirectory,
            ...definitions,
            unit,
            '/Fo' + join(directory, 'guard.obj'),
          ]);
          const result = spawnSync(command.file, command.args, {
            cwd: directory,
            encoding: 'utf8',
            timeout: 60_000,
            windowsVerbatimArguments: command.verbatim,
          });
          expect(result.error).toBeUndefined();
          expect(result.signal).toBeNull();
          expect(result.status).not.toBeNull();
          return { status: result.status, output: result.stdout + result.stderr };
        };
        for (const definitions of [
          [],
          finalDeclaration.map((definition) =>
            definition.replace(/(RULESET|CLASSIFIER|LEXICON)_VERSION=\d/u, '$1_VERSION=1'),
          ),
          [
            '/DSPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=1',
            '/DSPRINT_CODER_TEST_WINDOWS_EXPLORER_EXCEPTION=1',
            ...finalDeclaration.filter((definition) => !definition.includes('FROM_BUILD')),
          ],
        ]) {
          const result = compile(definitions);
          expect(result.status, result.output).toBe(0);
        }
        const final = compile(finalDeclaration);
        expect(final.status, final.output).not.toBe(0);
        expect(final.output).toContain(diagnostic);
        const forbidden = compile([
          ...finalDeclaration,
          '/DSPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=1',
          '/DSPRINT_CODER_TEST_WINDOWS_EXPLORER_EXCEPTION=1',
        ]);
        expect(forbidden.status, forbidden.output).not.toBe(0);
        expect(forbidden.output).toContain(
          'Explorer exception test seam must not enter a product build',
        );
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    }, 240_000);
  },
);
