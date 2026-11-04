import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// The IL-only anchor lives in the host .inc, which needs the whole host to compile. Its declaration
// block is taken verbatim from the source, so this unit compiles the real expression.
function ilOnlyAnchorDeclaration(): string {
  const source = readFileSync(
    join(nativeDirectory, 'computer_use_windows_host_target_facts.inc'),
    'utf8',
  );
  const start = source.indexOf('inline constexpr bool kWindowsIlOnlyImageAnchorReady');
  const end = source.indexOf('#endif', source.indexOf('#else', start));
  if (start < 0 || end < 0) throw new Error('IL-only anchor declaration not found');
  return source.slice(start, end + '#endif'.length);
}

describe.skipIf(process.platform !== 'win32')(
  'Windows production eligibility compile guard',
  () => {
    it('compiles the final declaration with only the approval route on, and keeps the test seam out', () => {
      const build = findBuild();
      expect(build, 'cl.exe (MSVC) is required').not.toBeNull();
      if (!build) throw new Error('MSVC unavailable');
      const directory = mkdtempSync(join(tmpdir(), 'sc-eligibility-build-'));
      const target = resolve(directory);
      if (!target.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected temporary path');
      try {
        const unit = join(directory, 'guard.cc');
        const compile = (definitions: string[], body = '') => {
          writeFileSync(unit, '#include "computer_use_windows_target_facts.h"\n' + body);
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
        // A final declaration compiles. The approval route follows the declaration alone, while
        // Explorer, Store Notepad not-web and the IL-only anchor each wait for their own flag.
        const checks = [
          ilOnlyAnchorDeclaration(),
          'namespace sc = sprint_coder::computer_use;',
          'static_assert(sc::kNativeEligibilityWindowsV2Final, "sc-check final declaration");',
          'static_assert(!sc::kWindowsExplorerException, "sc-check Explorer");',
          'static_assert(!sc::kWindowsStoreNotepadNotWeb, "sc-check Store Notepad");',
          'static_assert(!kWindowsIlOnlyImageAnchor, "sc-check IL-only anchor");',
          '',
        ].join('\n');
        const final = compile(finalDeclaration, checks);
        expect(final.status, final.output).toBe(0);
        // The same checks fail without the final declaration, so they are not vacuous.
        const current = compile([], checks);
        expect(current.status, current.output).not.toBe(0);
        expect(current.output).toContain('sc-check final declaration');
        expect(current.output).not.toMatch(/sc-check (?:Explorer|Store Notepad|IL-only anchor)/u);
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
