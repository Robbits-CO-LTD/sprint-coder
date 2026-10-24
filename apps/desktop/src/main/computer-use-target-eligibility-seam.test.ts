import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computerWindowsTargetFactsSchema } from '@sprint-coder/contracts';
import {
  cppFactsStatements,
  loadDenyRuleset,
  materializeGoldenCases,
} from '../../../../generate-computer-use-deny-ruleset.mjs';
import { DENY_RULESET } from './computer-use-deny-ruleset.generated';
import {
  classifyTargetExplained,
  denyRulesetCanonicalText,
  type TargetFacts,
} from './computer-use-target-eligibility';
import {
  randomTargetFacts,
  refusalMutations,
  seededRandom,
} from './computer-use-target-eligibility-fixture';

// Differential seam for the shared target eligibility core (S5-c-3, #500 PR-1): the C++ core
// (computer_use_target_eligibility.h) is compiled with the runner's compiler and given the same
// facts as the TS core (golden vectors, random targets and their refusal mutations); every answer,
// and the content hash each side rebuilds from its own tables, must agree. No window, process or
// pipe is used. The Windows v2 harness row sets COMPUTER_USE_SEAM_ELIGIBILITY_V2=1, which compiles
// the seam with -DSPRINT_CODER_ELIGIBILITY_V2=1 and requires the compiled mode to say so. Without
// a compiler the test is skipped, except in CI or when that row asks for v2.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const windowsHost = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
function nativeFunction(start: string, end: string): string {
  const from = windowsHost.indexOf(start);
  const to = windowsHost.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error('Native facts wire seam markers changed');
  return windowsHost.slice(from, to);
}
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const expectV2 = process.env['COMPUTER_USE_SEAM_ELIGIBILITY_V2'] === '1';

type Compiler = Readonly<{
  name: string;
  command: (path: string, output: string) => { file: string; args: string[]; verbatim: boolean };
}>;

function findCompiler(): Compiler | null {
  const v2 = expectV2
    ? ['SPRINT_CODER_ELIGIBILITY_V2=1', 'SPRINT_CODER_EXPECT_ELIGIBILITY_V2=1']
    : [];
  if (process.platform !== 'win32') {
    if (spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status !== 0) return null;
    return {
      name: 'clang++',
      command: (path, output) => ({
        file: 'clang++',
        args: [
          '-std=c++20',
          '-Wall',
          '-Wextra',
          '-fsanitize=address,undefined',
          ...v2.map((define) => `-D${define}`),
          `-I${nativeDirectory}`,
          path,
          '-o',
          output,
        ],
        verbatim: false,
      }),
    };
  }
  const clArguments = (path: string, output: string): string[] => [
    '/nologo',
    '/std:c++20',
    '/EHsc',
    '/W4',
    '/WX',
    '/sdl',
    '/utf-8',
    ...v2.map((define) => `/D${define}`),
    `/I${nativeDirectory}`,
    path,
    `/Fe:${output}`,
    `/Fo:${output}.obj`,
  ];
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return {
      name: 'cl.exe',
      command: (path, output) => ({
        file: 'cl.exe',
        args: clArguments(path, output),
        verbatim: false,
      }),
    };
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
    name: 'cl.exe (vcvars64)',
    command: (path, output) => ({
      file: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        `"call "${vcvars}" >nul && cl.exe ${clArguments(path, output)
          .map((argument) => `"${argument}"`)
          .join(' ')}"`,
      ],
      verbatim: true,
    }),
  };
}

const compiler = findCompiler();
const model = loadDenyRuleset();

function seamCases(): TargetFacts[] {
  const cases = materializeGoldenCases(model).map((entry) => entry.facts as unknown as TargetFacts);
  const admitted = cases.filter((facts) => classifyTargetExplained(facts).route !== null);
  cases.push({ ...admitted[0]!, imageLeaf: 'fixture"\\\n\t\u0001日本語' });
  const random = seededRandom(0x5eed);
  for (let index = 0; index < 150; index++) cases.push(randomTargetFacts(random));
  for (let index = 0; index < 150; index++)
    cases.push(randomTargetFacts(random, admitted[index % admitted.length]));
  // Every refusal mutation of the golden vectors, so a rule the two sides disagree on shows.
  for (const facts of cases.slice(0, 25))
    for (const mutation of refusalMutations(facts)) cases.push(mutation.facts);
  return cases;
}

const line = (facts: TargetFacts): string => {
  const explained = classifyTargetExplained(facts);
  const mode = 'maximumMode' in explained.verdict ? explained.verdict.maximumMode : '';
  return [explained.verdict.kind, explained.denyClass ?? '', explained.route ?? '', mode].join(
    '\t',
  );
};

function driver(cases: readonly TargetFacts[]): string {
  const out = [
    '#include "computer_use_native_eligibility.h"',
    '#include "computer_use_sha256.h"',
    '#include "computer_use_target_eligibility.h"',
    '#include <cstdio>',
    '#include <string>',
    nativeFunction('std::string JsonEscape(', 'bool ReadJsonString('),
    nativeFunction('std::string WindowsV2TargetFactsJson(', '// The identity JSON of a v2 row:'),
    '',
    'using namespace sprint_coder::computer_use;',
    '',
    'static void Emit(const TargetFacts &facts) {',
    '  if (facts.platform == TargetPlatform::kWin32)',
    '    std::printf("facts\\t%s\\n", WindowsV2TargetFactsJson(facts).c_str());',
    '  const TargetClassification c = ClassifyTargetExplained(facts);',
    '  std::printf("case\\t%s\\t%.*s\\t%.*s\\t%.*s\\n", std::string(TargetVerdictKindName(c.verdict.kind)).c_str(),',
    '              static_cast<int>(c.deny_class.size()), c.deny_class.data(),',
    '              static_cast<int>(c.route.size()), c.route.data(),',
    '              static_cast<int>(c.verdict.maximum_mode.size()), c.verdict.maximum_mode.data());',
    '}',
    '',
  ];
  const chunk = 40;
  const functions: string[] = [];
  for (let start = 0; start < cases.length; start += chunk) {
    const name = `Chunk${functions.length}`;
    functions.push(name);
    out.push(`static void ${name}() {`);
    for (const facts of cases.slice(start, start + chunk)) {
      out.push('  {', '    TargetFacts facts;');
      for (const statement of cppFactsStatements(model, 'facts', facts))
        out.push(`    ${statement}`);
      out.push('    Emit(facts);', '  }');
    }
    out.push('}', '');
  }
  out.push(
    'int main() {',
    '  std::printf("mode\\t%s\\n", kNativeEligibilityModeName);',
    '  for (const TargetPlatformRuleset &ruleset : kTargetPlatformRulesets)',
    '    std::printf("hash\\t%.*s\\t%s\\n", static_cast<int>(TargetPlatformName(ruleset.platform).size()),',
    '                TargetPlatformName(ruleset.platform).data(),',
    '                Sha256Hex(DenyRulesetCanonicalText(ruleset.platform)).c_str());',
    ...functions.map((name) => `  ${name}();`),
    '  return 0;',
    '}',
    '',
  );
  return out.join('\n');
}

/**
 * Runs a process without blocking the event loop: the build and the run take tens of seconds on CI
 * macOS, and a blocked worker cannot answer vitest's RPC (`Timeout calling "onTaskUpdate"`).
 */
function runAsync(
  file: string,
  args: readonly string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, [...args], {
      ...(options.env === undefined ? {} : { env: options.env }),
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill(), options.timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolvePromise({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

describe.skipIf(compiler === null && process.env['CI'] === undefined && !expectV2)(
  'target eligibility core differential seam (S5-c-3 PR-1)',
  () => {
    it('gives the C++ and TS cores the same answer for every case', async () => {
      expect(compiler, 'a C++ compiler is required to run this seam here').not.toBeNull();
      const cases = seamCases();
      expect(cases.length).toBeGreaterThan(1_500);
      const root = mkdtempSync(join(tmpdir(), 'computer-use-target-eligibility-seam-'));
      try {
        const path = join(root, 'seam.cc');
        const binary = join(root, process.platform === 'win32' ? 'seam.exe' : 'seam');
        writeFileSync(path, driver(cases));
        const command = compiler!.command(path, binary);
        const built = await runAsync(command.file, command.args, {
          timeout: 300_000,
          windowsVerbatimArguments: command.verbatim,
          env: { ...process.env, VSLANG: '1033' },
        });
        expect(built.status, `${compiler!.name}\n${built.stdout}\n${built.stderr}`).toBe(0);
        const run = await runAsync(binary, [], { timeout: 60_000 });
        expect(run.status, run.stderr).toBe(0);
        // Not trimmed: an empty class, route or mode is a trailing tab, and it is part of the answer.
        const lines = run.stdout.replace(/\r\n/gu, '\n').split('\n');
        expect(lines.pop()).toBe('');
        expect(lines[0]).toBe(`mode\t${expectV2 ? 'v2-denylist' : 'v1-allowlist'}`);
        const hashes = lines.filter((entry) => entry.startsWith('hash\t'));
        expect(hashes).toEqual(
          Object.keys(DENY_RULESET.platforms).map(
            (platform) =>
              `hash\t${platform}\t${createHash('sha256')
                .update(denyRulesetCanonicalText(platform)!, 'utf8')
                .digest('hex')}`,
          ),
        );
        const native = lines
          .filter((entry) => entry.startsWith('case\t'))
          .map((entry) => entry.slice(5));
        expect(native.length).toBe(cases.length);
        const disagreements = cases
          .map((facts, index) => ({ index, ts: line(facts), native: native[index] }))
          .filter((entry) => entry.ts !== entry.native);
        expect(disagreements.slice(0, 5)).toEqual([]);
        const windowsCases = cases.filter((facts) => facts.platform === 'win32');
        const wireFacts = lines
          .filter((entry) => entry.startsWith('facts\t'))
          .map((entry) => {
            const value: unknown = JSON.parse(entry.slice(6));
            return value;
          });
        expect(wireFacts).toEqual(windowsCases);
        for (const [index, facts] of wireFacts.entries()) {
          // Invalid-enum fuzz cases remain invalid rather than being normalized into permissions.
          expect(computerWindowsTargetFactsSchema.safeParse(facts).success).toBe(
            computerWindowsTargetFactsSchema.safeParse(windowsCases[index]).success,
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 600_000);
  },
);
